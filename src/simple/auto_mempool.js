
import 'dotenv/config';
import { ethers } from 'ethers';
import { watchMempoolAddLP } from './mempoolAddLPWatcher.js';
import { detectFeesBps, enforceStrictTax, rejectBySelectors, basePriceTokensPerEth, canBuyCallStatic } from './filters.js';
import { buyExactETH } from './buy.js';
import { managePosition } from './positionManager.js';
import { watchRugDefense } from './rugWatcher.js';
import { initNotifier } from './notifier.js';
import { priceEthForTokens } from './pricing.js';

function makeProvider(url){ return url.startsWith('wss') ? new ethers.WebSocketProvider(url) : new ethers.JsonRpcProvider(url); }
function cfg(){
  const e = process.env;
  const urls = (e.RPC_URLS||'').split(',').map(s=>s.trim()).filter(Boolean);
  if (!urls.length) throw new Error('RPC_URLS missing');
  return {
    urls,
    weth: e.WETH || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    router: e.ROUTER_V2 || '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    factory: e.FACTORY_V2 || '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    pk: e.PRIVATE_KEY,
    minLP: Number(e.MIN_LP_ETH||'0.5'),
    maxLP: Number(e.MAX_LP_ETH||'1'),
    taxMax: Number(e.STRICT_TAX_BPS_MAX||'0'),
    taxMode: (e.STRICT_TAX_MODE||'reject_unknown'),
    blocked: e.BLOCKLIST_SELECTORS || '',
    antiBot: Number(e.STRICT_ANTIBOT||'1')===1,
    buyWei: e.BUY_ETH ? ethers.parseEther(String(e.BUY_ETH)) : ethers.parseEther('0.01'),
    priceGuard: Number(e.PRICE_GUARD||'1')===1,
    priceMultipleAbort: Number(e.PRICE_MULTIPLE_ABORT||'3'),
    tpPct: Number(e.TP_PCT||'20'),
    timeoutSec: Number(e.TP_TIMEOUT_SEC||'600'),
    rugDefense: Number(e.RUG_DEFENSE||'1')===1,
    rugBp: Number(e.RUG_THRESHOLD_BP||'2000'),
    tipAddGwei: Number(e.PANIC_TIP_ADD_GWEI||'2'),
    maxFeeCap: Number(e.MAX_FEE_GWEI_CAP||'300'),
    maxPrioCap: Number(e.MAX_PRIORITY_FEE_GWEI_CAP||'200'),
    testWei: e.HONEYPOT_TEST_WEI ? ethers.parseEther(String(e.HONEYPOT_TEST_WEI)) : 0n,
    tgToken: e.TELEGRAM_TOKEN||'',
    tgChat: e.TELEGRAM_CHAT_ID||''
  };
}

(async () => {
  const c = cfg();
  const provider = makeProvider(c.urls[0]);
  const wallet = new ethers.Wallet(c.pk, provider);
  const notifier = initNotifier(c.tgToken, c.tgChat);

  notifier?.send?.(`[BOOT] ${await wallet.getAddress()} rpc=${c.urls[0]}`);

  let baseTokensPerEth = 0n;
  let rugHandle = null;

  watchMempoolAddLP({
    provider,
    routerList: [c.router],
    factory: c.factory,
    weth: c.weth,
    minLpEth: c.minLP,
    maxLpEth: c.maxLP,
    onCandidate: async ({ token, pair, eth }) => {
      try{
        notifier?.send?.(`[CANDIDATE] pair=${pair} token=${token} LP≈${eth}ETH`);

        // base price snapshot
        baseTokensPerEth = await basePriceTokensPerEth({ provider, router: c.router, token, weth: c.weth });
        if (baseTokensPerEth === 0n){
          notifier?.send?.('[SKIP] base price unavailable');
          return;
        }

        // tax strict
        const taxRes = await enforceStrictTax({ provider, token, strictMaxBps: c.taxMax, mode: c.taxMode });
        if (!taxRes.ok){ notifier?.send?.(`[SKIP] ${taxRes.reason}`); return; }

        // blocked selectors
        const selRes = await rejectBySelectors({ provider, token, blockedNamesCsv: c.blocked });
        if (!selRes.ok){ notifier?.send?.(`[SKIP] blocked selectors`); return; }

        // optional honeypot test: buy small + sell back
        if (c.testWei > 0n){
          notifier?.send?.('[TEST] honeypot test trade');
          const testTx = await buyExactETH({ router: c.router, weth: c.weth, token, wallet, amountWei: c.testWei });
          await testTx.wait?.(1);
          try{
            const { sold } = await (await import('./sell.js')).sellAll({ router: c.router, token, weth: c.weth, wallet });
            if (!sold){ notifier?.send?.('[SKIP] honeypot suspected'); return; }
          }catch{ notifier?.send?.('[SKIP] honeypot suspected'); return; }
        }

        // price guard vs base
        if (c.priceGuard){
          const nowTokens = await basePriceTokensPerEth({ provider, router: c.router, token, weth: c.weth });
          if (nowTokens === 0n){ notifier?.send?.('[SKIP] price query fail'); return; }
          // compare token per 1 ETH: if now <= base/3 → price went up >=3x (tokens cheaper)
          if (nowTokens * 3n <= baseTokensPerEth){
            notifier?.send?.('[SKIP] price > 3x base');
            return;
          }
        }

        // callStatic buy check
        const can = await canBuyCallStatic({ provider, router: c.router, weth: c.weth, token, from: await wallet.getAddress(), wei: c.buyWei/10n });
        if (!can){ notifier?.send?.('[SKIP] cannot buy'); return; }

        // buy
        const buyTx = await buyExactETH({ router: c.router, weth: c.weth, token, wallet, amountWei: c.buyWei });
        notifier?.send?.(`[BUY.TX] ${buyTx.hash}`);
        const rec = await buyTx.wait?.(1);

        // compute bought tokens
        const bal = await (new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)'], provider)).balanceOf(await wallet.getAddress());
        const buyTs = Math.floor(Date.now()/1000);
        notifier?.send?.(`[BUY.DONE] tokens=${bal} at ~ETH=${c.buyWei}`);

        // attach rug defense
        if (c.rugDefense && provider instanceof ethers.WebSocketProvider){
          rugHandle = watchRugDefense({
            provider, pair, routers:[c.router], thresholdBp:c.rugBp,
            onThreat: async ({ kind }) => {
              notifier?.send?.(`[RUG] detected kind=${kind} -> SELL NOW`);
              try{
                const { sold, hash, reason } = await (await import('./sell.js')).sellAll({ router: c.router, token, weth: c.weth, wallet });
                notifier?.send?.(sold?`[RUG.SELL.TX] ${hash}`:`[RUG.SELL.FAIL] ${reason||'unknown'}`);
              }catch(e){ notifier?.send?.(`[RUG.ERROR] ${e?.message||e}`); }
            }
          });
        }

        // start TP/timeout manager
        managePosition({
          provider, wallet, router: c.router, weth: c.weth, token,
          buyWeiCost: c.buyWei, buyTokenAmount: bal, buyTs,
          tpPct: c.tpPct, timeoutSec: c.timeoutSec, notifier
        });

      }catch(e){
        notifier?.send?.(`[CANDIDATE.ERROR] ${e?.message||e}`);
      }
    }
  });
})();
