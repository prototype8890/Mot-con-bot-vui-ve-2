
import { ethers } from 'ethers';
import { IUniswapV2Router } from './abi.js';

export async function buyExactETH({ router, weth, token, wallet, amountWei, deadlineSec=60 }){
  const iface = new ethers.Interface(IUniswapV2Router);
  const to = await wallet.getAddress();
  const deadline = Math.floor(Date.now()/1000)+deadlineSec;
  const data = iface.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens',[0,[weth,token],to,deadline]);
  return wallet.sendTransaction({ to: router, data, value: amountWei });
}
