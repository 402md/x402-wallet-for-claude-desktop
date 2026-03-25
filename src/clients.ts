import { x402Client, x402HTTPClient } from '@x402/core/client'
import type { PaymentNetwork, AppConfig } from '@/types.js'

const CAIP2_NETWORKS: Record<PaymentNetwork, string> = {
  stellar: 'stellar:pubnet',
  'stellar-testnet': 'stellar:testnet',
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532'
}

export function isStellarNetwork(network: PaymentNetwork): boolean {
  return network === 'stellar' || network === 'stellar-testnet'
}

export function isEvmNetwork(network: PaymentNetwork): boolean {
  return network === 'base' || network === 'base-sepolia'
}

export function getCaip2Network(network: PaymentNetwork): string {
  return CAIP2_NETWORKS[network]
}

export async function createHttpClient(
  network: PaymentNetwork,
  config: AppConfig
): Promise<x402HTTPClient> {
  const client = new x402Client()

  if (isStellarNetwork(network) && config.stellarSecret) {
    const { ExactStellarScheme, createEd25519Signer } =
      await import('@x402/stellar')
    const signer = createEd25519Signer(config.stellarSecret)
    const caip2 = getCaip2Network(network) as `${string}:${string}`
    const scheme = new ExactStellarScheme(signer)
    client.register(caip2, scheme)
  }

  if (isEvmNetwork(network) && config.evmPrivateKey) {
    const { registerExactEvmScheme } = await import('@x402/evm/exact/client')
    const { privateKeyToAccount } = await import('viem/accounts')
    const { createWalletClient, http, publicActions } = await import('viem')
    const { baseSepolia, base } = await import('viem/chains')

    const chain = network === 'base-sepolia' ? baseSepolia : base
    const account = privateKeyToAccount(config.evmPrivateKey as `0x${string}`)
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http()
    }).extend(publicActions)

    // The SDK expects signer.address at the top level,
    // but viem stores it at walletClient.account.address
    const signer = Object.assign(walletClient, { address: account.address })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerExactEvmScheme(client, { signer: signer as any })
  }

  return new x402HTTPClient(client)
}

export async function getWalletAddress(
  network: PaymentNetwork,
  config: AppConfig
): Promise<string> {
  if (isStellarNetwork(network) && config.stellarSecret) {
    const { createEd25519Signer } = await import('@x402/stellar')
    const signer = createEd25519Signer(config.stellarSecret)
    return signer.address
  }

  if (isEvmNetwork(network) && config.evmPrivateKey) {
    const { privateKeyToAccount } = await import('viem/accounts')
    const account = privateKeyToAccount(config.evmPrivateKey as `0x${string}`)
    return account.address
  }

  throw new Error(`No key configured for network ${network}`)
}

export async function getUsdcBalance(
  network: PaymentNetwork,
  config: AppConfig
): Promise<string> {
  if (isStellarNetwork(network) && config.stellarSecret) {
    const { createEd25519Signer, getHorizonClient } =
      await import('@x402/stellar')
    const signer = createEd25519Signer(config.stellarSecret)
    const caip2 = getCaip2Network(network) as `${string}:${string}`
    const horizon = getHorizonClient(caip2)

    try {
      const account = await horizon.loadAccount(signer.address)
      // Look for USDC trustline in balances
      for (const bal of account.balances) {
        if ('asset_code' in bal && bal.asset_code === 'USDC') {
          return bal.balance
        }
        // SAC (Soroban Asset Contract) — match by contract ID not feasible from Horizon
        // Fall back to checking if it's the native representation
      }
      return '0.0000000'
    } catch {
      return '0.0000000'
    }
  }

  if (isEvmNetwork(network) && config.evmPrivateKey) {
    const { privateKeyToAccount } = await import('viem/accounts')
    const { createPublicClient, http, erc20Abi } = await import('viem')
    const { baseSepolia, base } = await import('viem/chains')

    const chain = network === 'base-sepolia' ? baseSepolia : base
    const account = privateKeyToAccount(config.evmPrivateKey as `0x${string}`)
    const publicClient = createPublicClient({ chain, transport: http() })

    const USDC_ADDRESSES: Record<string, `0x${string}`> = {
      base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
    }

    const usdcAddress = USDC_ADDRESSES[network]
    if (!usdcAddress) return '0.000000'

    try {
      const balance = await publicClient.readContract({
        address: usdcAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address]
      })
      const decimals = 6
      const raw = BigInt(balance as bigint)
      const whole = raw / BigInt(10 ** decimals)
      const frac = raw % BigInt(10 ** decimals)
      return `${whole}.${frac.toString().padStart(decimals, '0')}`
    } catch {
      return '0.000000'
    }
  }

  throw new Error(`No key configured for network ${network}`)
}
