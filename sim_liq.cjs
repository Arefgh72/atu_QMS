const { ethers } = require('ethers');
const RPC='https://rpc.testnet.qms.finance';
const ROUTER='0x93AFF45f28e5DF1b55f5AEFEfB807De843b12619';
const WQMS='0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34';
const ME='0xFDA1d6115A49adf731570800D35C901ad4e0057B';
const tokens=[
 {sym:'USDT',addr:'0x72577544f4134a25E7f09d0B5FF0ca05A1249EbF',dec:6},
 {sym:'USDC',addr:'0xDfF68E53a0A8275212927c12017f5aB5f1842a04',dec:6},
 {sym:'WBTC',addr:'0xD0d47E0BFFfdF57d79DC42B03a0aF31e608EF2c6',dec:8},
];
const RABI=[
 'function getAmountsOut(uint256,address[]) view returns (uint256[])',
 'function addLiquidityETH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline) payable returns (uint256 amountToken,uint256 amountETH,uint256 liquidity)',
 'function factory() view returns (address)'];
const FABI=['function getPair(address,address) view returns (address)'];
const PABI=['function getReserves() view returns (uint112,uint112,uint32)','function totalSupply() view returns (uint256)','function token0() view returns (address)'];
const EABI=['function balanceOf(address) view returns (uint256)','function allowance(address,address) view returns (uint256)','function decimals() view returns (uint8)'];
(async()=>{
  const p=new ethers.JsonRpcProvider(RPC,19480,{staticNetwork:true});
  const router=new ethers.Contract(ROUTER,RABI,p);
  const factory=new ethers.Contract(await router.factory(),FABI,p);
  const iface=new ethers.Interface(RABI);
  const amount=ethers.parseEther('0.001');
  const deadline=Math.floor(Date.now()/1000)+1800;
  console.log('native balance:', ethers.formatEther(await p.getBalance(ME)));
  for(const t of tokens){
    const tokenC=new ethers.Contract(t.addr,EABI,p);
    const pairAddr=await factory.getPair(WQMS,t.addr);
    const pair=new ethers.Contract(pairAddr,PABI,p);
    const [r0,r1]=await pair.getReserves();
    const t0=await pair.token0();
    const wqmsIs0=t0.toLowerCase()===WQMS.toLowerCase();
    const resWqms=wqmsIs0?r0:r1, resTok=wqmsIs0?r1:r0;
    const lpTotal=await pair.totalSupply();
    const bal=await tokenC.balanceOf(ME);
    const allow=await tokenC.allowance(ME,ROUTER);
    const quoted=(await router.getAmountsOut(amount,[WQMS,t.addr]))[1];
    const tokenDesired=quoted < bal ? quoted : bal;
    const expectedEth=(tokenDesired*resWqms)/resTok;
    const expectedLp=(tokenDesired*lpTotal)/resTok;
    console.log(`${t.sym}: pair=${pairAddr}`);
    console.log(`   reserves WQMS=${ethers.formatEther(resWqms)} tok=${ethers.formatUnits(resTok,t.dec)} LPtotal=${ethers.formatEther(lpTotal)}`);
    console.log(`   wallet tok=${ethers.formatUnits(bal,t.dec)} allowance=${allow===ethers.MaxUint256?'MAX':allow.toString()}`);
    console.log(`   for 0.001 QMS need ${ethers.formatUnits(quoted,t.dec)} ${t.sym}; using ${ethers.formatUnits(tokenDesired,t.dec)} + ${ethers.formatEther(expectedEth)} QMS -> LP ~${ethers.formatEther(expectedLp)}`);
    const data=iface.encodeFunctionData('addLiquidityETH',[t.addr,tokenDesired,0,0,ME,deadline]);
    try{
      const r=await p.send('eth_call',[{from:ME,to:ROUTER,data,value:ethers.toBeHex(amount)},'latest']);
      const dec=iface.decodeFunctionResult('addLiquidityETH',r);
      console.log(`   SIM addLiquidityETH: OK -> used ${ethers.formatUnits(dec[0],t.dec)} ${t.sym} + ${ethers.formatEther(dec[1])} QMS, LP=${ethers.formatEther(dec[2])}`);
    }catch(e){
      console.log(`   SIM addLiquidityETH: FAIL -> ${(e.shortMessage||e.message).slice(0,120)}`);
    }
  }
})().catch(e=>{console.error('FATAL',e.shortMessage||e.message);process.exit(1)});
