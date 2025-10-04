
import { ethers } from 'ethers';
import { IUniswapV2Router, IUniswapV2Factory, IUniswapV2Pair } from './abi.js';
import { getReservesEth } from './filters.js';

const SEL = { addLiquidityETH: '0xf305d719', addLiquidity: '0xe8e33700' };

export function watchMempoolAddLP({ provider, routerList, factory, weth, minLpEth, maxLpEth, onCandidate }){
  if (!(provider instanceof ethers.WebSocketProvider)) { console.log('[mempool] need WSS'); return { stop:()=>{} }; }
  const routers = new Set(routerList.map(a=>a.toLowerCase()));
  const rIface = new ethers.Interface(IUniswapV2Router);
  const fIface = new ethers.Interface(IUniswapV2Factory);
  const pIface = new ethers.Interface(IUniswapV2Pair);
  const pairCreated = fIface.getEvent('PairCreated').topicHash;
  const mintTopic = pIface.getEvent('Mint').topicHash;

  const pending = new Map(); // token-> meta

  const onPending = async (hash) => {
    try{
      const tx = await provider.getTransaction(hash);
      if (!tx || !tx.to) return;
      const to = tx.to.toLowerCase();
      if (!routers.has(to)) return;
      const sel = (tx.data||'0x').slice(0,10);
      if (sel !== SEL.addLiquidityETH && sel !== SEL.addLiquidity) return;

      let token = null, ethFloat = 0;
      if (sel === SEL.addLiquidityETH){
        const parsed = rIface.parseTransaction({ data: tx.data });
        token = parsed.args[0];
        ethFloat = Number(ethers.formatEther(tx.value||0n));
      } else {
        const parsed = rIface.parseTransaction({ data: tx.data });
        const [a,b, aDesired, bDesired] = [parsed.args[0], parsed.args[1], parsed.args[2], parsed.args[3]];
        if (a.toLowerCase()===weth.toLowerCase()) ethFloat = Number(ethers.formatEther(aDesired));
        if (b.toLowerCase()===weth.toLowerCase()) ethFloat = Number(ethers.formatEther(bDesired));
        token = a.toLowerCase()===weth.toLowerCase()? b : (b.toLowerCase()===weth.toLowerCase()? a : null);
      }
      if (!token) return;
      if (ethFloat < minLpEth || ethFloat > maxLpEth) return;
      pending.set(token.toLowerCase(), { eth: ethFloat });
    }catch{}
  };

  provider.on('pending', onPending);

  const pairFilter = { address: factory, topics: [pairCreated] };
  provider.on(pairFilter, async (log) => {
    try{
      const { args } = fIface.parseLog(log);
      const [t0, t1, pair] = [args[0], args[1], args[2]];
      const token = t0.toLowerCase()===weth.toLowerCase()? t1.toLowerCase()
                  : t1.toLowerCase()===weth.toLowerCase()? t0.toLowerCase() : null;
      if (!token) return;
      const meta = pending.get(token);
      if (!meta) return;
      const mintFilter = { address: pair, topics: [mintTopic] };
      const once = async () => {
        provider.off(mintFilter, once);
        const { ethReserve } = await getReservesEth({ provider, pair, weth });
        const ethNow = Number(ethers.formatEther(ethReserve));
        if (ethNow >= minLpEth && ethNow <= maxLpEth){
          onCandidate({ token, pair, eth: ethNow });
        }
        pending.delete(token);
      };
      provider.on(mintFilter, once);
    }catch{}
  });

  return { stop: ()=>{ try{ provider.off('pending', onPending); provider.off(pairFilter);}catch{} } };
}
