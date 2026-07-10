import type { AppConfig, PaymentNetwork } from '@/types.js'
import { createEvmSigner } from '@/clients.js'

export interface EnsurePermit2Params {
  network: PaymentNetwork
  config: AppConfig
  asset: `0x${string}`
  requiredAmount: bigint
  /** Server declared a gas-sponsoring extension; the SDK signs the approval off-chain */
  gaslessDeclared?: boolean
}

export interface EnsurePermit2Result {
  status: 'sufficient' | 'approved' | 'skipped-gasless'
  approvalTxHash?: `0x${string}`
}

/**
 * The upto scheme settles through Permit2, which needs a one-time on-chain
 * USDC approval from the wallet. Checks the current allowance and submits
 * the approval transaction when it is missing (unless the server sponsors
 * the approval gas via an extension, in which case the SDK handles it).
 */
export async function ensurePermit2Allowance(
  params: EnsurePermit2Params
): Promise<EnsurePermit2Result> {
  const { network, config, asset, requiredAmount, gaslessDeclared } = params

  const { getPermit2AllowanceReadParams, createPermit2ApprovalTx } =
    await import('@x402/evm/upto/client')

  const signer = await createEvmSigner(network, config)

  const allowance = (await signer.readContract(
    getPermit2AllowanceReadParams({
      tokenAddress: asset,
      ownerAddress: signer.address
    })
  )) as bigint

  if (allowance >= requiredAmount) {
    return { status: 'sufficient' }
  }

  if (gaslessDeclared) {
    return { status: 'skipped-gasless' }
  }

  const noEthError = new Error(
    `Permit2 approval required for upto payments, but the wallet has no ETH on ${network} to pay for gas. ` +
      `Send a small amount of ETH to ${signer.address} for this one-time approval, ` +
      `or use a server that supports gasless (EIP-2612) approvals.`
  )

  const ethBalance = await signer.getBalance({ address: signer.address })
  if (ethBalance === 0n) {
    throw noEthError
  }

  const tx = createPermit2ApprovalTx(asset)
  let hash: `0x${string}`
  try {
    hash = await signer.sendTransaction({
      to: tx.to,
      data: tx.data,
      chain: signer.chain,
      account: signer.account!
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/insufficient funds/i.test(message)) {
      throw noEthError
    }
    throw err
  }

  const receipt = await signer.waitForTransactionReceipt({
    hash,
    timeout: 60_000
  })
  if (receipt.status !== 'success') {
    throw new Error(
      `Permit2 approval transaction reverted on ${network}: ${hash}`
    )
  }

  return { status: 'approved', approvalTxHash: hash }
}
