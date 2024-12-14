import { AnyType } from "@/utils.js";
import { Memory, Provider, IAgentRuntime, State } from "@ai16z/eliza";
import { ethers } from "ethers";
import { chainMap } from "../../utils.js";

export class CollabLandWalletBalanceProvider implements Provider {
  async get(
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<AnyType> {
    let chain: string | null = null;
    const onChainMemoryManager = _runtime.getMemoryManager("onchain")!;
    // this is newest to oldest
    const onChainMemories = await onChainMemoryManager.getMemories({
      roomId: _message.roomId,
      unique: false,
    });
    console.log(
      "[CollabLandWalletBalanceProvider] onChainMemories",
      onChainMemories
    );
    for (const memory of onChainMemories) {
      if (memory.content.chain !== undefined) {
        chain = memory.content.chain as string;
        break;
      }
    }
    // Get the chain Id
    if (chain == null) {
      return "";
    }
    console.log(
      "[CollabLandWalletBalanceProvider] chain found in memories",
      chain
    );

    const chainId = chainMap[chain as keyof typeof chainMap];
    if (!chainId) {
      return "";
    }

    let account = null;
    for (const memory of onChainMemories) {
      if (memory.content.smartAccount && memory.content.chainId === chainId) {
        account = memory.content;
        break;
      }
    }

    if (!account?.smartAccount) {
      return "";
    }
    console.log(
      "[CollabLandWalletBalanceProvider] account found in memories",
      account
    );
    const provider = ethers.getDefaultProvider(chainId);
    const balance = await provider.getBalance(account.smartAccount as string);
    const formattedBalance = ethers.formatEther(balance);
    console.log("[CollabLandWalletBalanceProvider] balance", formattedBalance);
    return `Agent's balance is ${formattedBalance} ETH on ${chain}`;
  }
}
