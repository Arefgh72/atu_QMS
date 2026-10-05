# atu_QMS — ربات چرخه سواپ QMS Testnet

هر ۱۲ ساعت به‌صورت خودکار روی **شبکه تست‌نت QMS** (Chain ID `19480`) این چرخه را انجام می‌دهد:

1. **وارپ** — ۰.۰۰۱ QMS بومی → WQMS  (`WQMS.deposit`)
2. **سواپ تصادفی** — ۰.۰۰۱ QMS → یکی از **USDT / USDC / WBTC**؛ هر بار یکی از این سه با احتمال دقیقاً **۱/۳** انتخاب می‌شود (`QwapRouter.swapExactETHForTokens`)
3. **آن‌وارپ** — همان ۰.۰۰۱ WQMS مرحله ۱ → QMS  (`WQMS.withdraw`)
4. **سواپ برگشتی** — کل مقدار توکنی که در مرحله ۲ گرفته → QMS  (`QwapRouter.swapExactTokensForETH`)

نوع توکن انتخاب‌شده و دقیقاً عدد مقداری که در مرحله ۲ گرفته شده در `logs/swap-cycles.jsonl` ثبت و به ریپو کامیت می‌شود. خلاصه آخرین اجرا در `logs/last-cycle.json` است.

## راه‌اندازی (یک‌بار)

### ۱) اضافه کردن کلید خصوصی به‌عنوان Secret

والت EVM را در Secret به نام `EVM_PRIVATE_KEY` بگذار (هیچ‌وقت کلید را در چت/کد نگذار):

- از ترمینال: `gh secret set EVM_PRIVATE_KEY --repo Arefgh72/atu_QMS` و مقدار را در پرامپت پیست کن
- یا از وب: `Settings → Secrets and variables → Actions → New repository secret` با نام `EVM_PRIVATE_KEY`

از یک **والت تستی جداگانه** استفاده کن؛ تست‌نت است و ارزشی ندارد.

### ۲) شارژ ولت با توکن تستی

برو به <https://faucet.testnet.qms.finance> و آدرس ولت را بزن: هر درخواست ۱۰ QMS است و ۲۴ ساعته ۴ بار مجاز است. هر چرخه حدود ۰.۰۰۲ QMS + کارمزد گس مصرف می‌کند.

### ۳) اجرای تستی

تب **Actions** → workflow **QMS Swap Cycle** → **Run workflow**. (اجرای زمان‌بندی‌شده خودکار از ساعت‌های ۰۰:۰۰ و ۱۲:۰۰ UTC شروع می‌شود.)

## فایل‌ها

| مسیر | توضیح |
| --- | --- |
| `.github/workflows/qms-swap-cycle.yml` | اکشن: کرون هر ۱۲ ساعت + اجرای دستی + کامیت لاگ |
| `scripts/qms-swap-cycle.mjs` | اسکریپت چرخه (Node 20 + ethers v6) |
| `logs/swap-cycles.jsonl` | تاریخچه هر چرخه (JSON در هر خط) |
| `logs/last-cycle.json` | خلاصه آخرین چرخه |

## تنظیمات (اختیاری)

از طریق `workflow_dispatch` یا متغیرهای محیطی:

| متغیر | پیش‌فرض | توضیح |
| --- | --- | --- |
| `AMOUNT_QMS` | `0.001` | مقدار QMS در هر مرحله |
| `SLIPPAGE_BPS` | `200` | حد لغزش (۲۰۰ = ۲٪) |
| `RPC_URL` | `https://rpc.testnet.qms.finance` | اندپوینت RPC |

## آدرس‌های استفاده‌شده (QMS Testnet)

| مورد | آدرس |
| --- | --- |
| QwapRouter | `0x93AFF45f28e5DF1b55f5AEFEfB807De843b12619` |
| WQMS (Wrapped QMS) | `0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34` |
| USDT | `0x72577544f4134a25E7f09d0B5FF0ca05A1249EbF` |
| USDC | `0xDfF68E53a0A8275212927c12017f5aB5f1842a04` |
| WBTC | `0xD0d47E0BFFfdF57d79DC42B03a0aF31e608EF2c6` |
| اکسپلورر | <https://testnet.qmsscan.io> |

## نکته‌ها

- اجرای زمان‌بندی‌شده در GitHub ممکن است چند دقیقه دیرتر شروع شود؛ کرون روی دقیقه‌های شلوغ تاخیر دارد.
- اگر ۶۰ روز هیچ فعالیتی در ریپو نباشد GitHub زمان‌بندی را غیرفعال می‌کند؛ کامیت‌های خودکار لاگ این را زنده نگه می‌دارند.
- اسکریپت اول موجودی را چک می‌کند؛ اگر ولت QMS کافی نداشته باشد با پیام واضح (و درخواست فاست) fail می‌شود.
- تست محلی بدون ارسال تراکنش: `DRY_RUN=1 EVM_PRIVATE_KEY=<هر کلید دلخواه> node scripts/qms-swap-cycle.mjs`
