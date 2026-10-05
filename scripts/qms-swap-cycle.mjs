/**
 * QMS Testnet swap cycle — runs every 12 hours from GitHub Actions.
 *
 * One cycle:
 *   1) wrap   : 0.001 QMS (native) -> 0.001 WQMS              [WQMS.deposit]
 *   2) swap   : 0.001 QMS -> one of USDT / USDC / WBTC,       [router.swapExactETHForTokens]
 *               picked uniformly at random (1/3 each)
 *   3) unwrap : the WQMS wrapped in step 1 -> QMS             [WQMS.withdraw]
 *   4) swap   : the token received in step 2 -> QMS           [router.swapExactTokensForETH]
 *               the token symbol and the amount received are recorded in logs/swap-cycles.jsonl
 *
 * Note on steps 1-3: step 2 feeds the router from the native balance (the router
 * wraps its input itself), so the WQMS wrapped in step 1 stays intact for the
 * explicit unwrap in step 3.
 *
 * Config via env:
 *   EVM_PRIVATE_KEY  (required)  private key of the EVM wallet, from repo secrets
 *   RPC_URL          default https://rpc.testnet.qms.finance
 *   AMOUNT_QMS       default 0.001
 *   SLIPPAGE_BPS     default 200 (2%)
 *   DRY_RUN=1        read-only: checks + quotes, sends nothing, writes no log
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = join(REPO_ROOT, 'logs');

const RPC_URL = process.env.RPC_URL ?? 'https://rpc.testnet.qms.finance';
const CHAIN_ID = 19480;
const AMOUNT = process.env.AMOUNT_QMS ?? '0.001';
const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS ?? '200'); // 2%
const DRY_RUN = process.env.DRY_RUN === '1';

// Qwap DEX on QMS Testnet (verified on testnet.qmsscan.io)
const ROUTER_ADDRESS = '0x93AFF45f28e5DF1b55f5AEFEfB807De843b12619';
const WQMS_ADDRESS = '0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34';
const TOKENS = [
  { symbol: 'USDT', address: '0x72577544f4134a25E7f09d0B5FF0ca05A1249EbF', decimals: 6 },
  { symbol: 'USDC', address: '0xDfF68E53a0A8275212927c12017f5aB5f1842a04', decimals: 6 },
  { symbol: 'WBTC', address: '0xD0d47E0BFFfdF57d79DC42B03a0aF31e608EF2c6', decimals: 8 },
];

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
];
const WQMS_ABI = [
  'function deposit() payable',
  'function withdraw(uint256 amount)',
  'function balanceOf(address) view returns (uint256)',
];
const ROUTER_ABI = [
  'function WQMS() view returns (address)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
];

const fmt = (v, d = 18) => ethers.formatUnits(v, d);
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const deadline = () => Math.floor(Date.now() / 1000) + 1800;

async function send(txPromise, label) {
  const tx = await txPromise;
  log(`${label}: sent ${tx.hash}`);
  const receipt = await tx.wait();
  const gasWei = receipt.gasUsed * receipt.gasPrice;
  log(`${label}: confirmed in block ${receipt.blockNumber} (gas ${receipt.gasUsed}, cost ${ethers.formatEther(gasWei)} QMS)`);
  return { tx, receipt, gasWei };
}

async function main() {
  const pk = (process.env.EVM_PRIVATE_KEY ?? process.env.PRIVATE_KEY ?? '').trim();
  if (!DRY_RUN && !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error(
      'EVM_PRIVATE_KEY is missing or invalid. Add it as a repository secret (64 hex chars, 0x-prefixed).'
    );
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(CHAIN_ID)) {
    throw new Error(`Wrong chain: expected ${CHAIN_ID}, got ${network.chainId}`);
  }

  const wallet = new ethers.Wallet(pk || ethers.Wallet.createRandom().privateKey, provider);
  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  const wqms = new ethers.Contract(WQMS_ADDRESS, WQMS_ABI, wallet);
  const amount = ethers.parseEther(AMOUNT);

  const routerWqms = await router.WQMS();
  if (routerWqms.toLowerCase() !== WQMS_ADDRESS.toLowerCase()) {
    throw new Error(`Router WQMS (${routerWqms}) does not match expected ${WQMS_ADDRESS}`);
  }

  log(`wallet ${wallet.address} | chain ${network.chainId} | amount ${AMOUNT} QMS | dryRun ${DRY_RUN}`);

  const nativeBefore = await provider.getBalance(wallet.address);
  if (!DRY_RUN) {
    // 2x the swapped amount (steps 2 and 4 move the same value through the DEX)
    // plus a gas buffer: ~400k gas across the cycle at ~10 gwei is ~0.004 QMS.
    const minNeeded = amount * 2n + ethers.parseEther('0.01');
    if (nativeBefore < minNeeded) {
      throw new Error(
        `Wallet ${wallet.address} holds ${ethers.formatEther(nativeBefore)} QMS; ` +
          `need at least ${ethers.formatEther(minNeeded)} QMS (2x ${AMOUNT} + gas buffer). ` +
          'Request testnet QMS at https://faucet.testnet.qms.finance and re-run.'
      );
    }
  }

  // ---- 1/4 wrap ----------------------------------------------------------
  const wqmsBefore = await wqms.balanceOf(wallet.address);
  let wrapRx = null;
  if (!DRY_RUN) {
    wrapRx = await send(wqms.deposit({ value: amount }), `1/4 wrap ${AMOUNT} QMS -> WQMS`);
  }
  const wrappedDelta = (await wqms.balanceOf(wallet.address)) - wqmsBefore;
  log(`1/4 wrapped ${fmt(wrappedDelta)} WQMS`);

  // ---- 2/4 random swap to USDT / USDC / WBTC (1/3 each) -------------------
  const pick = randomInt(0, TOKENS.length);
  const token = TOKENS[pick];
  log(`2/4 random pick #${pick} of ${TOKENS.length} -> ${token.symbol}`);
  const tokenContract = new ethers.Contract(token.address, ERC20_ABI, wallet);

  const [quotedOut] = [
    (await router.getAmountsOut(amount, [WQMS_ADDRESS, token.address]))[1],
  ];
  const minOut = (quotedOut * (10000n - SLIPPAGE_BPS)) / 10000n;
  log(`2/4 quote: ${AMOUNT} QMS -> ${fmt(quotedOut, token.decimals)} ${token.symbol} (minOut ${fmt(minOut, token.decimals)})`);

  const tokenBefore = await tokenContract.balanceOf(wallet.address);
  let swapRx = null;
  if (!DRY_RUN) {
    swapRx = await send(
      router.swapExactETHForTokens(minOut, [WQMS_ADDRESS, token.address], wallet.address, deadline(), {
        value: amount,
      }),
      `2/4 swap ${AMOUNT} QMS -> ${token.symbol}`
    );
  }
  const tokenReceived = (await tokenContract.balanceOf(wallet.address)) - tokenBefore;
  log(`2/4 received ${fmt(tokenReceived, token.decimals)} ${token.symbol}`);

  // ---- 3/4 unwrap the WQMS wrapped in step 1 ------------------------------
  let unwrapRx = null;
  if (!DRY_RUN) {
    if (wrappedDelta > 0n) {
      unwrapRx = await send(wqms.withdraw(wrappedDelta), `3/4 unwrap ${fmt(wrappedDelta)} WQMS -> QMS`);
    } else {
      log('3/4 nothing to unwrap (wrapped delta was zero)');
    }
  } else {
    log(`3/4 would unwrap ${AMOUNT} WQMS -> QMS`);
  }

  // ---- 4/4 swap the received token back to QMS ----------------------------
  let backRx = null;
  let approveRx = null;
  let nativeReturned = 0n;
  let quotedBack = 0n;
  if (!DRY_RUN) {
    if (tokenReceived === 0n) {
      throw new Error(`Swap produced 0 ${token.symbol}; aborting before step 4.`);
    }
    const allowance = await tokenContract.allowance(wallet.address, ROUTER_ADDRESS);
    if (allowance < tokenReceived) {
      approveRx = await send(tokenContract.approve(ROUTER_ADDRESS, ethers.MaxUint256), `4/4 approve ${token.symbol}`);
    }
    quotedBack = (await router.getAmountsOut(tokenReceived, [token.address, WQMS_ADDRESS]))[1];
    const minBack = (quotedBack * (10000n - SLIPPAGE_BPS)) / 10000n;
    const nativeBeforeBack = await provider.getBalance(wallet.address);
    backRx = await send(
      router.swapExactTokensForETH(
        tokenReceived,
        minBack,
        [token.address, WQMS_ADDRESS],
        wallet.address,
        deadline()
      ),
      `4/4 swap ${fmt(tokenReceived, token.decimals)} ${token.symbol} -> QMS`
    );
    const nativeAfterBack = await provider.getBalance(wallet.address);
    nativeReturned = nativeAfterBack - nativeBeforeBack + backRx.gasWei;
    log(`4/4 returned ${ethers.formatEther(nativeReturned)} QMS for ${fmt(tokenReceived, token.decimals)} ${token.symbol}`);
  } else {
    log(`4/4 would swap the received ${token.symbol} back to QMS`);
  }

  const nativeAfter = await provider.getBalance(wallet.address);
  const gasWei =
    (wrapRx?.gasWei ?? 0n) + (swapRx?.gasWei ?? 0n) + (approveRx?.gasWei ?? 0n) + (unwrapRx?.gasWei ?? 0n) + (backRx?.gasWei ?? 0n);

  const entry = {
    timestamp: new Date().toISOString(),
    status: 'ok',
    wallet: wallet.address,
    chainId: CHAIN_ID,
    amountQms: AMOUNT,
    // step 2 outcome: which token and exactly how much of it was received
    chosenToken: token.symbol,
    chosenTokenAddress: token.address,
    tokenDecimals: token.decimals,
    tokenAmountReceived: fmt(tokenReceived, token.decimals),
    tokenAmountReceivedRaw: tokenReceived.toString(),
    quotedTokenOut: fmt(quotedOut, token.decimals),
    quotedBackQms: fmt(quotedBack),
    nativeReturnedQms: ethers.formatEther(nativeReturned),
    nativeBalanceBefore: ethers.formatEther(nativeBefore),
    nativeBalanceAfter: ethers.formatEther(nativeAfter),
    gasCostQms: ethers.formatEther(gasWei),
    txHashes: {
      wrap: wrapRx?.tx.hash ?? null,
      swap: swapRx?.tx.hash ?? null,
      unwrap: unwrapRx?.tx.hash ?? null,
      approve: approveRx?.tx.hash ?? null,
      swapBack: backRx?.tx.hash ?? null,
    },
  };

  if (!DRY_RUN) {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, 'swap-cycles.jsonl'), JSON.stringify(entry) + '\n');
    writeFileSync(join(LOG_DIR, 'last-cycle.json'), JSON.stringify(entry, null, 2) + '\n');
    log('log written to logs/swap-cycles.jsonl');
  }

  log('cycle completed:');
  console.log(JSON.stringify(entry, null, 2));
}

main().catch((err) => {
  const message = err?.shortMessage ?? err?.message ?? String(err);
  console.error('ERROR:', message);
  if (!DRY_RUN) {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      appendFileSync(
        join(LOG_DIR, 'swap-cycles.jsonl'),
        JSON.stringify({ timestamp: new Date().toISOString(), status: 'error', error: message }) + '\n'
      );
    } catch {
      /* logging is best-effort */
    }
  }
  process.exit(1);
});
