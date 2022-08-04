import {
  GOERLI,
  GOERLI_CHAIN_ID,
  KOVAN,
  KOVAN_CHAIN_ID,
  MAINNET,
  MAINNET_CHAIN_ID,
  RINKEBY,
  RINKEBY_CHAIN_ID,
  ROPSTEN,
  ROPSTEN_CHAIN_ID,
  ROPSTEN_RPC_URL,
  NETWORK_TYPE_RPC,
  QTUM_MAINNET_CHAIN_ID,
  QTUM_TESTNET_CHAIN_ID,
  QTUM_REGTEST_CHAIN_ID,
  QTUM_MAINNET_RPC_URL,
  QTUM_TESTNET_RPC_URL,
  QTUM_REGTEST_RPC_URL,
  getRpcUrl,
  ETH_SYMBOL,
  TEST_NETWORK_TICKER_MAP,
} from '../../../../shared/constants/network';

const defaultNetworksData = [
  {
    labelKey: 'qtumMainnet',
    iconColor: '#29B6AF',
    providerType: 'qtumMainnet',
    rpcUrl: QTUM_MAINNET_RPC_URL,
    chainId: QTUM_MAINNET_CHAIN_ID,
    ticker: 'QTUM',
    blockExplorerUrl: 'https://etherscan.io',
  },
  {
    labelKey: 'qtumTestnet',
    iconColor: '#29B6AF',
    providerType: 'qtumTestnet',
    rpcUrl: QTUM_TESTNET_RPC_URL,
    chainId: QTUM_TESTNET_CHAIN_ID,
    ticker: 'QTUM',
    blockExplorerUrl: 'https://etherscan.io',
  },
  {
    labelKey: 'qtumRegtest',
    iconColor: '#29B6AF',
    providerType: NETWORK_TYPE_RPC,
    rpcUrl: QTUM_REGTEST_RPC_URL,
    chainId: QTUM_REGTEST_CHAIN_ID,
    ticker: 'QTUM',
    blockExplorerUrl: 'https://etherscan.io',
  },
  /*
  {
    labelKey: MAINNET,
    iconColor: '#29B6AF',
    providerType: MAINNET,
    rpcUrl: getRpcUrl({ network: MAINNET, excludeProjectId: true }),
    chainId: MAINNET_CHAIN_ID,
    ticker: ETH_SYMBOL,
    blockExplorerUrl: 'https://etherscan.io',
  },
  {
    labelKey: ROPSTEN,
    iconColor: '#FF4A8D',
    providerType: ROPSTEN,
    rpcUrl: getRpcUrl({ network: ROPSTEN, excludeProjectId: true }),
    chainId: ROPSTEN_CHAIN_ID,
    ticker: TEST_NETWORK_TICKER_MAP[ROPSTEN],
    blockExplorerUrl: 'https://ropsten.etherscan.io',
  },
  {
    labelKey: RINKEBY,
    iconColor: '#F6C343',
    providerType: RINKEBY,
    rpcUrl: getRpcUrl({ network: RINKEBY, excludeProjectId: true }),
    chainId: RINKEBY_CHAIN_ID,
    ticker: TEST_NETWORK_TICKER_MAP[RINKEBY],
    blockExplorerUrl: 'https://rinkeby.etherscan.io',
  },
  {
    labelKey: GOERLI,
    iconColor: '#3099f2',
    providerType: GOERLI,
    rpcUrl: getRpcUrl({ network: GOERLI, excludeProjectId: true }),
    chainId: GOERLI_CHAIN_ID,
    ticker: TEST_NETWORK_TICKER_MAP[GOERLI],
    blockExplorerUrl: 'https://goerli.etherscan.io',
  },
  {
    labelKey: KOVAN,
    iconColor: '#9064FF',
    providerType: KOVAN,
    rpcUrl: getRpcUrl({ network: KOVAN, excludeProjectId: true }),
    chainId: KOVAN_CHAIN_ID,
    ticker: TEST_NETWORK_TICKER_MAP[KOVAN],
    blockExplorerUrl: 'https://kovan.etherscan.io',
  },
  */
];

export { defaultNetworksData };
