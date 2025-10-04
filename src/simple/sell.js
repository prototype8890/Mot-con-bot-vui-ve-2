
import { ethers } from 'ethers';
import { IUniswapV2Router, IERC20 } from './abi.js';

export async function sellAll({ router, token, weth, wallet, minOut=0n, deadlineSec=60 }){
  const erc = new ethers.Contract(token, IERC20, wallet);
  const bal = await erc.balanceOf(await wallet.getAddress());
  if (bal === 0n) return { sold:false, reason:'zero-balance' };

  try{ const txA = await erc.approve(router, bal); await txA.wait?.(1); }catch{}

  const iface = new ethers.Interface(IUniswapV2Router);
  const to = await wallet.getAddress();
  const data = iface.encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens',
    [bal, minOut, [token, weth], to, Math.floor(Date.now()/1000)+deadlineSec]
  );
  const tx = await wallet.sendTransaction({ to: router, data });
  return { sold:true, hash: tx.hash };
}
