
import { ethers } from 'ethers';
import { IERC20, IUniswapV2Pair, IUniswapV2Router } from './abi.js';

export async function getReservesEth({ provider, pair, weth }){
  const c = new ethers.Contract(pair, IUniswapV2Pair, provider);
  const [t0, t1] = await Promise.all([c.token0(), c.token1()]);
  const [r0, r1] = await c.getReserves();
  const ethReserve = t0.toLowerCase()===weth.toLowerCase()? r0 : (t1.toLowerCase()===weth.toLowerCase()? r1 : 0n);
  return { ethReserve, token: t0.toLowerCase()===weth.toLowerCase()? t1 : t0 };
}

export async function detectFeesBps({ provider, token }){
  const names = ['buyFee','sellFee','_buyFee','_sellFee','_tax','tax','taxFee','_transferFee','_totalFee','fees','_fees','liquidityFee','marketingFee'];
  const erc = new ethers.Contract(token, IERC20, provider);
  try{ await erc.decimals(); }catch{ return -1; }
  const iface = new ethers.Interface(names.map(n=>`function ${n}() view returns (uint256)`));
  const vals = [];
  for (const n of names){
    try{
      const raw = await provider.call({ to: token, data: iface.encodeFunctionData(n,[]) });
      vals.push(Number(ethers.toBigInt(raw)));
    }catch{}
  }
  if (!vals.length) return -1;
  const m = Math.max(...vals);
  return m <= 1000 ? m : -1;
}

export async function detectOwnerRisk({ provider, token }){
  const sigs = [
    'function owner() view returns (address)',
    'function getOwner() view returns (address)',
    'function tradingEnabled() view returns (bool)',
    'function tradingOpen() view returns (bool)'
  ];
  const iface = new ethers.Interface(sigs);
  const call = async (name)=>{
    try{ const raw = await provider.call({ to: token, data: iface.encodeFunctionData(name,[]) }); return iface.decodeFunctionResult(name, raw)[0]; }catch{ return undefined; }
  };
  const ownerA = await call('owner');
  const ownerB = await call('getOwner');
  const tradingEnabled = await call('tradingEnabled');
  const tradingOpen = await call('tradingOpen');
  return { owner: ownerA ?? ownerB ?? null, tradingEnabled, tradingOpen };
}

export async function canBuyCallStatic({ provider, router, weth, token, from, wei }){
  const iface = new ethers.Interface(IUniswapV2Router);
  const deadline = Math.floor(Date.now()/1000)+60;
  try{
    await provider.call({ to: router, value: wei, from, data: iface.encodeFunctionData('swapExactETHForTokens',[0,[weth,token],from,deadline]) });
    return true;
  }catch{
    try{
      await provider.call({ to: router, value: wei, from, data: iface.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens',[0,[weth,token],from,deadline]) });
      return true;
    }catch{ return false; }
  }
}



import { priceEthForTokens } from './pricing.js';
import { computeBlockedSelectors, bytecodeHasAnySelector } from './selectorScan.js';

export async function enforceStrictTax({ provider, token, strictMaxBps, mode }){
  const bps = await detectFeesBps({ provider, token });
  if (bps < 0) {
    if ((mode||'').toLowerCase()==='reject_unknown') return { ok:false, reason:'tax_unknown' };
    return { ok:true, reason:'tax_unknown_allowed' };
  }
  if (bps > strictMaxBps) return { ok:false, reason:`tax_${bps}_bps_gt_${strictMaxBps}` };
  return { ok:true };
}

export async function rejectBySelectors({ provider, token, blockedNamesCsv }){
  const names = (blockedNamesCsv||'').split(',').map(s=>s.trim()).filter(Boolean);
  if (!names.length) return { ok:true };
  const blockedSel = computeBlockedSelectors(names);
  const code = await provider.getCode(token);
  const hit = bytecodeHasAnySelector(code, blockedSel);
  return hit ? { ok:false, reason:'blocked_selector' } : { ok:true };
}

export async function basePriceTokensPerEth({ provider, router, token, weth }){
  const out = await priceEthForTokens({ provider, router, token, weth });
  return out; // tokens per 1 ETH
}
