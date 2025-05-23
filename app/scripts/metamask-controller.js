import EventEmitter from 'events';
import { QtumWallet, hashMessage } from 'qtum-ethers-wrapper';
import pump from 'pump';
import { ObservableStore } from '@metamask/obs-store';
import { storeAsStream } from '@metamask/obs-store/dist/asStream';
import { createAsyncMiddleware, createScaffoldMiddleware, JsonRpcEngine } from 'json-rpc-engine';
import { debounce } from 'lodash';
import createEngineStream from 'json-rpc-middleware-stream/engineStream';
import createFilterMiddleware from 'eth-json-rpc-filters';
import createSubscriptionManager from 'eth-json-rpc-filters/subscriptionManager';
import { providerAsMiddleware } from 'eth-json-rpc-middleware';
import KeyringController from 'eth-keyring-controller';
import {
  errorCodes as rpcErrorCodes,
  EthereumRpcError,
  ethErrors,
} from 'eth-rpc-errors';
import { Mutex } from 'await-semaphore';
import { addHexPrefix, stripHexPrefix, toBuffer, keccak } from 'ethereumjs-util';
import log from 'loglevel';
import TrezorKeyring from 'eth-trezor-keyring';
import LedgerBridgeKeyring from '@metamask/eth-ledger-bridge-keyring';
import LatticeKeyring from 'eth-lattice-keyring';
import { MetaMaskKeyring as QRHardwareKeyring } from '@keystonehq/metamask-airgapped-keyring';
import EthQuery from 'eth-query';
import nanoid from 'nanoid';
import { captureException } from '@sentry/browser';
import {
  AddressBookController,
  ApprovalController,
  ControllerMessenger,
  CurrencyRateController,
  PhishingController,
  AnnouncementController,
  GasFeeController,
  TokenListController,
  TokensController,
  TokenRatesController,
  CollectiblesController,
  AssetsContractController,
  CollectibleDetectionController,
  PermissionController,
  SubjectMetadataController,
  ///: BEGIN:ONLY_INCLUDE_IN(flask)
  RateLimitController,
  NotificationController,
  ///: END:ONLY_INCLUDE_IN
} from '@metamask/controllers';
import SmartTransactionsController from '@metamask/smart-transactions-controller';
import {
  SnapController,
  IframeExecutionService,
} from '@metamask/snap-controllers';
import { satisfies as satisfiesSemver } from 'semver';
import { jsonRpcRequest } from '../../shared/modules/rpc.utils';
import {
  ASSET_TYPES,
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
} from '../../shared/constants/transaction';
import { PHISHING_NEW_ISSUE_URLS } from '../../shared/constants/phishing';
import {
  GAS_API_BASE_URL,
  GAS_DEV_API_BASE_URL,
  SWAPS_CLIENT_ID,
} from '../../shared/constants/swaps';
import { MAINNET_CHAIN_ID } from '../../shared/constants/network';
import {
  DEVICE_NAMES,
  KEYRING_TYPES,
} from '../../shared/constants/hardware-wallets';
import {
  CaveatTypes,
  RestrictedMethods,
  ///: BEGIN:ONLY_INCLUDE_IN(flask)
  EndowmentPermissions,
  ///: END:ONLY_INCLUDE_IN
} from '../../shared/constants/permissions';
import { UI_NOTIFICATIONS } from '../../shared/notifications';
import { toChecksumHexAddress } from '../../shared/modules/hexstring-utils';
import { MILLISECOND } from '../../shared/constants/time';
import {
  ORIGIN_METAMASK,
  ///: BEGIN:ONLY_INCLUDE_IN(flask)
  MESSAGE_TYPE,
  ///: END:ONLY_INCLUDE_IN
  POLLING_TOKEN_ENVIRONMENT_TYPES,
  SUBJECT_TYPES,
} from '../../shared/constants/app';
import { EVENT, EVENT_NAMES } from '../../shared/constants/metametrics';

import { hexToDecimal } from '../../ui/helpers/utils/conversions.util';
import {
  getTokenIdParam,
  getTokenValueParam,
} from '../../ui/helpers/utils/token-util';
import { isEqualCaseInsensitive } from '../../shared/modules/string-utils';
import { parseStandardTokenTransactionData } from '../../shared/modules/transaction.utils';
import nodeify from './lib/nodeify';
import { STATIC_MAINNET_TOKEN_LIST } from '../../shared/constants/tokens';
import {
  onMessageReceived,
  checkForMultipleVersionsRunning,
} from './detect-multiple-instances';
import ComposableObservableStore from './lib/ComposableObservableStore';
import AccountTracker from './lib/account-tracker';
import createLoggerMiddleware from './lib/createLoggerMiddleware';
import {
  createMethodMiddleware,
  ///: BEGIN:ONLY_INCLUDE_IN(flask)
  createSnapMethodMiddleware,
  ///: END:ONLY_INCLUDE_IN
} from './lib/rpc-method-middleware';
import createOriginMiddleware from './lib/createOriginMiddleware';
import createTabIdMiddleware from './lib/createTabIdMiddleware';
import createOnboardingMiddleware from './lib/createOnboardingMiddleware';
import { setupMultiplex } from './lib/stream-utils';
import EnsController from './controllers/ens';
import NetworkController, { NETWORK_EVENTS } from './controllers/network';
import PreferencesController from './controllers/preferences';
import AppStateController from './controllers/app-state';
import CachedBalancesController from './controllers/cached-balances';
import AlertController from './controllers/alert';
import OnboardingController from './controllers/onboarding';
import ThreeBoxController from './controllers/threebox';
import BackupController from './controllers/backup';
import IncomingTransactionsController from './controllers/incoming-transactions';
import MessageManager, { normalizeMsgData } from './lib/message-manager';
import DecryptMessageManager from './lib/decrypt-message-manager';
import EncryptionPublicKeyManager from './lib/encryption-public-key-manager';
import PersonalMessageManager from './lib/personal-message-manager';
import TypedMessageManager from './lib/typed-message-manager';
import TransactionController from './controllers/transactions';
import DetectTokensController from './controllers/detect-tokens';
import SwapsController from './controllers/swaps';
import accountImporter from './account-import-strategies';
import seedPhraseVerifier from './lib/seed-phrase-verifier';
import MetaMetricsController from './controllers/metametrics';
import { segment } from './lib/segment';
import createMetaRPCHandler from './lib/createMetaRPCHandler';
import {
  CaveatMutatorFactories,
  getCaveatSpecifications,
  getChangedAccounts,
  getPermissionBackgroundApiMethods,
  getPermissionSpecifications,
  getPermittedAccountsByOrigin,
  NOTIFICATION_NAMES,
  PermissionLogController,
  unrestrictedMethods,
  ///: BEGIN:ONLY_INCLUDE_IN(flask)
  buildSnapEndowmentSpecifications,
  buildSnapRestrictedMethodSpecifications,
  ///: END:ONLY_INCLUDE_IN
} from './controllers/permissions';
import createRPCMethodTrackingMiddleware from './lib/createRPCMethodTrackingMiddleware';

import BigNumber from 'bignumber.js';
import qtum from 'qtumjs-lib';
import wif from 'wif';
import { signTypedDataLegacy, typedSignatureHash, TypedDataUtils, normalize } from 'eth-sig-util';
import { WIFKeyring } from './controllers/WIFKeyring';

export const METAMASK_CONTROLLER_EVENTS = {
  // Fired after state changes that impact the extension badge (unapproved msg count)
  // The process of updating the badge happens in app/scripts/background.js.
  UPDATE_BADGE: 'updateBadge',
  // TODO: Add this and similar enums to @metamask/controllers and export them
  APPROVAL_STATE_CHANGE: 'ApprovalController:stateChange',
};

// stream channels
const PHISHING_SAFELIST = 'qnekt-phishing-safelist';

export default class MetamaskController extends EventEmitter {
  /**
   * @param {object} opts
   */
  constructor(opts) {
    super();

    this.defaultMaxListeners = 20;

    this.sendUpdate = debounce(
      this.privateSendUpdate.bind(this),
      MILLISECOND * 200,
    );
    this.opts = opts;
    this.extension = opts.browser;
    this.platform = opts.platform;
    this.notificationManager = opts.notificationManager;
    const initState = opts.initState || {};
    const version = this.platform.getVersion();
    this.recordFirstTimeInfo(initState);

    // this keeps track of how many "controllerStream" connections are open
    // the only thing that uses controller connections are open metamask UI instances
    this.activeControllerConnections = 0;

    this.getRequestAccountTabIds = opts.getRequestAccountTabIds;
    this.getOpenMetamaskTabsIds = opts.getOpenMetamaskTabsIds;

    this.controllerMessenger = new ControllerMessenger();

    // observable state store
    this.store = new ComposableObservableStore({
      state: initState,
      controllerMessenger: this.controllerMessenger,
      persist: true,
    });

    // external connections by origin
    // Do not modify directly. Use the associated methods.
    this.connections = {};

    // lock to ensure only one vault created at once
    this.createVaultMutex = new Mutex();

    this.extension.runtime.onInstalled.addListener((details) => {
      if (details.reason === 'update' && version === '8.1.0') {
        this.platform.openExtensionInBrowser();
      }
    });

    // next, we will initialize the controllers
    // controller initialization order matters

    this.approvalController = new ApprovalController({
      messenger: this.controllerMessenger.getRestricted({
        name: 'ApprovalController',
      }),
      showApprovalRequest: opts.showUserConfirmation,
    });

    this.networkController = new NetworkController(initState.NetworkController);
    this.networkController.setInfuraProjectId(opts.infuraProjectId);

    // now we can initialize the RPC provider, which other controllers require
    this.initializeProvider();
    this.provider =
      this.networkController.getProviderAndBlockTracker().provider;
    this.blockTracker =
      this.networkController.getProviderAndBlockTracker().blockTracker;

    const tokenListMessenger = this.controllerMessenger.getRestricted({
      name: 'TokenListController',
    });

    this.tokenListController = new TokenListController({
      chainId: hexToDecimal(this.networkController.getCurrentChainId()),
      preventPollingOnNetworkRestart: true,
      onNetworkStateChange: (cb) => {
        this.networkController.store.subscribe((networkState) => {
          const modifiedNetworkState = {
            ...networkState,
            provider: {
              ...networkState.provider,
              chainId: hexToDecimal(networkState.provider.chainId),
            },
          };
          return cb(modifiedNetworkState);
        });
      },
      messenger: tokenListMessenger,
      state: initState.TokenListController,
    });

    this.preferencesController = new PreferencesController({
      initState: initState.PreferencesController,
      initLangCode: opts.initLangCode,
      openPopup: opts.openPopup,
      network: this.networkController,
      tokenListController: this.tokenListController,
      provider: this.provider,
      migrateAddressBookState: this.migrateAddressBookState.bind(this),
    });

    this.tokensController = new TokensController({
      onPreferencesStateChange: this.preferencesController.store.subscribe.bind(
        this.preferencesController.store,
      ),
      onNetworkStateChange: this.networkController.store.subscribe.bind(
        this.networkController.store,
      ),
      config: { provider: this.provider },
      state: initState.TokensController,
    });

    this.assetsContractController = new AssetsContractController(
      {
        onPreferencesStateChange: (listener) =>
          this.preferencesController.store.subscribe(listener),
        onNetworkStateChange: (cb) =>
          this.networkController.store.subscribe((networkState) => {
            const modifiedNetworkState = {
              ...networkState,
              provider: {
                ...networkState.provider,
                chainId: hexToDecimal(networkState.provider.chainId),
              },
            };
            return cb(modifiedNetworkState);
          }),
      },
      {
        provider: this.provider,
      },
      initState.AssetsContractController,
    );

    this.collectiblesController = new CollectiblesController(
      {
        onPreferencesStateChange:
          this.preferencesController.store.subscribe.bind(
            this.preferencesController.store,
          ),
        onNetworkStateChange: this.networkController.store.subscribe.bind(
          this.networkController.store,
        ),
        getERC721AssetName:
          this.assetsContractController.getERC721AssetName.bind(
            this.assetsContractController,
          ),
        getERC721AssetSymbol:
          this.assetsContractController.getERC721AssetSymbol.bind(
            this.assetsContractController,
          ),
        getERC721TokenURI: this.assetsContractController.getERC721TokenURI.bind(
          this.assetsContractController,
        ),
        getERC721OwnerOf: this.assetsContractController.getERC721OwnerOf.bind(
          this.assetsContractController,
        ),
        getERC1155BalanceOf:
          this.assetsContractController.getERC1155BalanceOf.bind(
            this.assetsContractController,
          ),
        getERC1155TokenURI:
          this.assetsContractController.getERC1155TokenURI.bind(
            this.assetsContractController,
          ),
        onCollectibleAdded: ({ address, symbol, tokenId, standard, source }) =>
          this.metaMetricsController.trackEvent({
            event: EVENT_NAMES.NFT_ADDED,
            category: EVENT.CATEGORIES.WALLET,
            properties: {
              token_contract_address: address,
              token_symbol: symbol,
              asset_type: ASSET_TYPES.COLLECTIBLE,
              token_standard: standard,
              source,
            },
            sensitiveProperties: {
              tokenId,
            },
          }),
      },
      {},
      initState.CollectiblesController,
    );

    this.collectiblesController.setApiKey(process.env.OPENSEA_KEY);

    process.env.COLLECTIBLES_V1 &&
      (this.collectibleDetectionController = new CollectibleDetectionController(
        {
          onCollectiblesStateChange: (listener) =>
            this.collectiblesController.subscribe(listener),
          onPreferencesStateChange:
            this.preferencesController.store.subscribe.bind(
              this.preferencesController.store,
            ),
          onNetworkStateChange: this.networkController.store.subscribe.bind(
            this.networkController.store,
          ),
          getOpenSeaApiKey: () => this.collectiblesController.openSeaApiKey,
          getBalancesInSingleCall:
            this.assetsContractController.getBalancesInSingleCall.bind(
              this.assetsContractController,
            ),
          addCollectible: this.collectiblesController.addCollectible.bind(
            this.collectiblesController,
          ),
          getCollectiblesState: () => this.collectiblesController.state,
        },
      ));

    this.metaMetricsController = new MetaMetricsController({
      segment,
      preferencesStore: this.preferencesController.store,
      onNetworkDidChange: this.networkController.on.bind(
        this.networkController,
        NETWORK_EVENTS.NETWORK_DID_CHANGE,
      ),
      getNetworkIdentifier: this.networkController.getNetworkIdentifier.bind(
        this.networkController,
      ),
      getCurrentChainId: this.networkController.getCurrentChainId.bind(
        this.networkController,
      ),
      version: this.platform.getVersion(),
      environment: process.env.METAMASK_ENVIRONMENT,
      extension: this.extension,
      initState: initState.MetaMetricsController,
      captureException,
    });

    this.on('update', (update) => {
      this.metaMetricsController.handleMetaMaskStateUpdate(update);
    });

    const gasFeeMessenger = this.controllerMessenger.getRestricted({
      name: 'GasFeeController',
    });

    const gasApiBaseUrl = process.env.SWAPS_USE_DEV_APIS
      ? GAS_DEV_API_BASE_URL
      : GAS_API_BASE_URL;

    this.gasFeeController = new GasFeeController({
      interval: 10000,
      messenger: gasFeeMessenger,
      clientId: SWAPS_CLIENT_ID,
      getProvider: () =>
        this.networkController.getProviderAndBlockTracker().provider,
      onNetworkStateChange: this.networkController.on.bind(
        this.networkController,
        NETWORK_EVENTS.NETWORK_DID_CHANGE,
      ),
      getCurrentNetworkEIP1559Compatibility:
        this.networkController.getEIP1559Compatibility.bind(
          this.networkController,
        ),
      getCurrentAccountEIP1559Compatibility:
        this.getCurrentAccountEIP1559Compatibility.bind(this),
      legacyAPIEndpoint: `${gasApiBaseUrl}/networks/<chain_id>/gasPrices`,
      EIP1559APIEndpoint: `${gasApiBaseUrl}/networks/<chain_id>/suggestedGasFees`,
      getCurrentNetworkLegacyGasAPICompatibility: () => {
        const chainId = this.networkController.getCurrentChainId();
        return process.env.IN_TEST || chainId === MAINNET_CHAIN_ID;
      },
      getChainId: () => {
        return process.env.IN_TEST
          ? MAINNET_CHAIN_ID
          : this.networkController.getCurrentChainId();
      },
    });

    const self = this;
    const gasFeeController = this.gasFeeController;
    this.gasFeeController._fetchEthGasPriceEstimate = this.gasFeeController.fetchEthGasPriceEstimate;
    this.gasFeeController.fetchEthGasPriceEstimate = (ethQuery) => {
        return new Promise((resolve, reject) => {
            // check web3_clientVersion
            ethQuery.sendAsync({
                method: "web3_clientVersion",
            }, function(err, result) {
                if (err) {
                    reject(err);
                } else {
                    const hasBug = result === "QTUM ETHTestRPC/ethereum-js";
                    self.txController.hasBug = hasBug;
                    gasFeeController._fetchEthGasPriceEstimate(ethQuery)
                        .then((result) => {
                            if (hasBug) {
                                if (result.hasOwnProperty("gasPrice")) {
                                    if (result.gasPrice === '40') {
                                        result.gasPrice = '400';
                                    }
                                }
                            } else if ((typeof result) == "string" && result.startsWith("MetaMask")) {
                                throw new Error("MetaMask web3_clientVersion isn't passed through to rpc endpoint")
                            }

                            resolve(result);
                        })
                        .catch((err) => {
                            console.error(err);
                            reject(err);
                        });
                }
            });
        });
    };

    this.qrHardwareKeyring = new QRHardwareKeyring();

    this.appStateController = new AppStateController({
      addUnlockListener: this.on.bind(this, 'unlock'),
      isUnlocked: this.isUnlocked.bind(this),
      initState: initState.AppStateController,
      onInactiveTimeout: () => this.setLocked(),
      showUnlockRequest: opts.showUserConfirmation,
      preferencesStore: this.preferencesController.store,
      qrHardwareStore: this.qrHardwareKeyring.getMemStore(),
    });

    const currencyRateMessenger = this.controllerMessenger.getRestricted({
      name: 'CurrencyRateController',
    });
    this.currencyRateController = new CurrencyRateController({
      includeUsdRate: true,
      messenger: currencyRateMessenger,
      state: {
        ...initState.CurrencyController,
        nativeCurrency: this.networkController.providerStore.getState().ticker,
      },
    });

    this.phishingController = new PhishingController();

    this.announcementController = new AnnouncementController(
      { allAnnouncements: UI_NOTIFICATIONS },
      initState.AnnouncementController,
    );

    // token exchange rate tracker
    this.tokenRatesController = new TokenRatesController({
      onTokensStateChange: (listener) =>
        this.tokensController.subscribe(listener),
      onCurrencyRateStateChange: (listener) =>
        this.controllerMessenger.subscribe(
          `${this.currencyRateController.name}:stateChange`,
          listener,
        ),
      onNetworkStateChange: (cb) =>
        this.networkController.store.subscribe((networkState) => {
          const modifiedNetworkState = {
            ...networkState,
            provider: {
              ...networkState.provider,
              chainId: hexToDecimal(networkState.provider.chainId),
            },
          };
          return cb(modifiedNetworkState);
        }),
    });

    this.ensController = new EnsController({
      provider: this.provider,
      getCurrentChainId: this.networkController.getCurrentChainId.bind(
        this.networkController,
      ),
      onNetworkDidChange: this.networkController.on.bind(
        this.networkController,
        NETWORK_EVENTS.NETWORK_DID_CHANGE,
      ),
    });

    this.incomingTransactionsController = new IncomingTransactionsController({
      blockTracker: this.blockTracker,
      onNetworkDidChange: this.networkController.on.bind(
        this.networkController,
        NETWORK_EVENTS.NETWORK_DID_CHANGE,
      ),
      getCurrentChainId: this.networkController.getCurrentChainId.bind(
        this.networkController,
      ),
      preferencesController: this.preferencesController,
      initState: initState.IncomingTransactionsController,
    });

    // account tracker watches balances, nonces, and any code at their address
    this.accountTracker = new AccountTracker({
      provider: this.provider,
      blockTracker: this.blockTracker,
      getCurrentChainId: this.networkController.getCurrentChainId.bind(
        this.networkController,
      ),
      metamaskController: this,
    });

    // start and stop polling for balances based on activeControllerConnections
    this.on('controllerConnectionChanged', (activeControllerConnections) => {
      if (activeControllerConnections > 0) {
        this.accountTracker.start();
        this.incomingTransactionsController.start();
        this.currencyRateController.start();
        if (this.preferencesController.store.getState().useTokenDetection) {
          this.tokenListController.start();
        }
      } else {
        this.accountTracker.stop();
        this.incomingTransactionsController.stop();
        this.currencyRateController.stop();
        if (this.preferencesController.store.getState().useTokenDetection) {
          this.tokenListController.stop();
        }
      }
    });

    this.cachedBalancesController = new CachedBalancesController({
      accountTracker: this.accountTracker,
      getCurrentChainId: this.networkController.getCurrentChainId.bind(
        this.networkController,
      ),
      initState: initState.CachedBalancesController,
    });

    this.onboardingController = new OnboardingController({
      initState: initState.OnboardingController,
    });

    this.tokensController.hub.on('pendingSuggestedAsset', async () => {
      await opts.openPopup();
    });

    const additionalKeyrings = [
      TrezorKeyring,
      LedgerBridgeKeyring,
      LatticeKeyring,
      QRHardwareKeyring,
      WIFKeyring,
    ];
    this.keyringController = new KeyringController({
      keyringTypes: additionalKeyrings,
      initState: initState.KeyringController,
      encryptor: opts.encryptor || undefined,
    });
    this.keyringController.on("update", async () => {
      const accounts = await this.keyringController.getAccounts();
      if (accounts.length > 0) {
        this.updateQtumAccounts(accounts);
      }
    })
    this.keyringController.memStore.subscribe((state) =>
      this._onKeyringControllerUpdate(state),
    );
    this.keyringController.on('unlock', () => this._onUnlock());
    this.keyringController.on('lock', () => this._onLock());

    const getIdentities = () =>
      this.preferencesController.store.getState().identities;

    this.permissionController = new PermissionController({
      messenger: this.controllerMessenger.getRestricted({
        name: 'PermissionController',
        allowedActions: [
          `${this.approvalController.name}:addRequest`,
          `${this.approvalController.name}:hasRequest`,
          `${this.approvalController.name}:acceptRequest`,
          `${this.approvalController.name}:rejectRequest`,
          'btc_sign', 
        ],
      }),
      state: initState.PermissionController,
      caveatSpecifications: getCaveatSpecifications({ getIdentities }),
      permissionSpecifications: {
        ...getPermissionSpecifications({
          getIdentities,
          getAllAccounts: this.keyringController.getAccounts.bind(
            this.keyringController,
          ),
          captureKeyringTypesWithMissingIdentities: (
            identities = {},
            accounts = [],
          ) => {
            const accountsMissingIdentities = accounts.filter(
              (address) => !identities[address],
            );
            const keyringTypesWithMissingIdentities =
              accountsMissingIdentities.map(
                (address) =>
                  this.keyringController.getKeyringForAccount(address)?.type,
              );

            const identitiesCount = Object.keys(identities || {}).length;

            const accountTrackerCount = Object.keys(
              this.accountTracker.store.getState().accounts || {},
            ).length;

            captureException(
              new Error(
                `Attempt to get permission specifications failed because their were ${accounts.length} accounts, but ${identitiesCount} identities, and the ${keyringTypesWithMissingIdentities} keyrings included accounts with missing identities. Meanwhile, there are ${accountTrackerCount} accounts in the account tracker.`,
              ),
            );
          },
        }),
        ///: BEGIN:ONLY_INCLUDE_IN(flask)
        ...this.getSnapPermissionSpecifications(),
        ///: END:ONLY_INCLUDE_IN
      },
      unrestrictedMethods,
    });

    this.permissionLogController = new PermissionLogController({
      restrictedMethods: new Set(Object.keys(RestrictedMethods)),
      initState: initState.PermissionLogController,
    });

    this.subjectMetadataController = new SubjectMetadataController({
      messenger: this.controllerMessenger.getRestricted({
        name: 'SubjectMetadataController',
        allowedActions: [`${this.permissionController.name}:hasPermissions`],
      }),
      state: initState.SubjectMetadataController,
      subjectCacheLimit: 100,
    });

    ///: BEGIN:ONLY_INCLUDE_IN(flask)
    this.snapExecutionService = new IframeExecutionService({
      iframeUrl: new URL(
        'https://metamask.github.io/iframe-execution-environment/0.7.0',
      ),
      messenger: this.controllerMessenger.getRestricted({
        name: 'ExecutionService',
      }),
      setupSnapProvider: this.setupSnapProvider.bind(this),
    });

    const snapControllerMessenger = this.controllerMessenger.getRestricted({
      name: 'SnapController',
      allowedEvents: [
        'ExecutionService:unhandledError',
        'ExecutionService:outboundRequest',
        'ExecutionService:outboundResponse',
      ],
      allowedActions: [
        `${this.permissionController.name}:getEndowments`,
        `${this.permissionController.name}:getPermissions`,
        `${this.permissionController.name}:hasPermission`,
        `${this.permissionController.name}:hasPermissions`,
        `${this.permissionController.name}:requestPermissions`,
        `${this.permissionController.name}:revokeAllPermissions`,
        `${this.permissionController.name}:revokePermissions`,
        `${this.permissionController.name}:revokePermissionForAllSubjects`,
        `${this.approvalController.name}:addRequest`,
        `${this.permissionController.name}:grantPermissions`,
        'ExecutionService:executeSnap',
        'ExecutionService:getRpcRequestHandler',
        'ExecutionService:terminateSnap',
        'ExecutionService:terminateAllSnaps',
        'ExecutionService:handleRpcRequest',
      ],
    });

    const SNAP_BLOCKLIST = [
      {
        id: 'npm:@consensys/starknet-snap',
        versionRange: '<0.1.11',
      },
    ];

    this.snapController = new SnapController({
      environmentEndowmentPermissions: Object.values(EndowmentPermissions),
      closeAllConnections: this.removeAllConnections.bind(this),
      // Prefix subject with appKeyType to generate separate keys for separate uses
      getAppKey: async (subject, appKeyType) => {
        await this.appStateController.getUnlockPromise(true);
        return this.getAppKeyForSubject(`${appKeyType}:${subject}`);
      },
      checkBlockList: async (snapsToCheck) => {
        return Object.entries(snapsToCheck).reduce(
          (acc, [snapId, snapVersion]) => {
            const blockInfo = SNAP_BLOCKLIST.find(
              (blocked) =>
                blocked.id === snapId &&
                satisfiesSemver(snapVersion, blocked.versionRange, {
                  includePrerelease: true,
                }),
            );

            const cur = blockInfo
              ? {
                  blocked: true,
                  reason: blockInfo.reason,
                  infoUrl: blockInfo.infoUrl,
                }
              : { blocked: false };
            return { ...acc, [snapId]: cur };
          },
          {},
        );
      },
      state: initState.SnapController,
      messenger: snapControllerMessenger,
      featureFlags: { dappsCanUpdateSnaps: true },
    });

    this.notificationController = new NotificationController({
      messenger: this.controllerMessenger.getRestricted({
        name: 'NotificationController',
      }),
      state: initState.NotificationController,
    });

    this.rateLimitController = new RateLimitController({
      messenger: this.controllerMessenger.getRestricted({
        name: 'RateLimitController',
      }),
      implementations: {
        showNativeNotification: (origin, message) => {
          const subjectMetadataState = this.controllerMessenger.call(
            'SubjectMetadataController:getState',
          );

          const originMetadata = subjectMetadataState.subjectMetadata[origin];

          this.platform._showNotification(
            originMetadata?.name ?? origin,
            message,
          );
          return null;
        },
        showInAppNotification: (origin, message) => {
          this.controllerMessenger.call(
            'NotificationController:show',
            origin,
            message,
          );

          return null;
        },
      },
    });
    ///: END:ONLY_INCLUDE_IN
    this.detectTokensController = new DetectTokensController({
      preferences: this.preferencesController,
      tokensController: this.tokensController,
      assetsContractController: this.assetsContractController,
      network: this.networkController,
      keyringMemStore: this.keyringController.memStore,
      tokenList: this.tokenListController,
      trackMetaMetricsEvent: this.metaMetricsController.trackEvent.bind(
        this.metaMetricsController,
      ),
    });

    this.addressBookController = new AddressBookController(
      undefined,
      initState.AddressBookController,
    );

    this.alertController = new AlertController({
      initState: initState.AlertController,
      preferencesStore: this.preferencesController.store,
    });

    this.threeBoxController = new ThreeBoxController({
      preferencesController: this.preferencesController,
      addressBookController: this.addressBookController,
      keyringController: this.keyringController,
      initState: initState.ThreeBoxController,
      getKeyringControllerState: this.keyringController.memStore.getState.bind(
        this.keyringController.memStore,
      ),
      version,
      trackMetaMetricsEvent: this.metaMetricsController.trackEvent.bind(
        this.metaMetricsController,
      ),
    });

    this.backupController = new BackupController({
      preferencesController: this.preferencesController,
      addressBookController: this.addressBookController,
      trackMetaMetricsEvent: this.metaMetricsController.trackEvent.bind(
        this.metaMetricsController,
      ),
    });

    this.txController = new TransactionController({
      initState:
        initState.TransactionController || initState.TransactionManager,
      getPermittedAccounts: this.getPermittedAccounts.bind(this),
      getProviderConfig: this.networkController.getProviderConfig.bind(
        this.networkController,
      ),
      getCurrentNetworkEIP1559Compatibility:
        this.networkController.getEIP1559Compatibility.bind(
          this.networkController,
        ),
      getCurrentAccountEIP1559Compatibility:
        this.getCurrentAccountEIP1559Compatibility.bind(this),
      networkStore: this.networkController.networkStore,
      getCurrentChainId: this.networkController.getCurrentChainId.bind(
        this.networkController,
      ),
      preferencesStore: this.preferencesController.store,
      txHistoryLimit: 60,
      signTransaction: this.keyringController.signTransaction.bind(
        this.keyringController,
      ),
      provider: this.provider,
      blockTracker: this.blockTracker,
      createEventFragment: this.metaMetricsController.createEventFragment.bind(
        this.metaMetricsController,
      ),
      updateEventFragment: this.metaMetricsController.updateEventFragment.bind(
        this.metaMetricsController,
      ),
      finalizeEventFragment:
        this.metaMetricsController.finalizeEventFragment.bind(
          this.metaMetricsController,
        ),
      getEventFragmentById:
        this.metaMetricsController.getEventFragmentById.bind(
          this.metaMetricsController,
        ),
      trackMetaMetricsEvent: this.metaMetricsController.trackEvent.bind(
        this.metaMetricsController,
      ),
      getParticipateInMetrics: () =>
        this.metaMetricsController.state.participateInMetaMetrics,
      getEIP1559GasFeeEstimates:
        this.gasFeeController.fetchGasFeeEstimates.bind(this.gasFeeController),
      getExternalPendingTransactions:
        this.getExternalPendingTransactions.bind(this),
      getAccountType: this.getAccountType.bind(this),
      getDeviceModel: this.getDeviceModel.bind(this),
      getTokenStandardAndDetails:
        this.assetsContractController.getTokenStandardAndDetails.bind(
          this.assetsContractController,
        ),
    });
    this.txController.on('newUnapprovedTx', () => opts.showUserConfirmation());

    this.txController.on(`tx:status-update`, async (txId, status) => {
      if (
        status === TRANSACTION_STATUSES.CONFIRMED ||
        status === TRANSACTION_STATUSES.FAILED
      ) {
        const txMeta = this.txController.txStateManager.getTransaction(txId);
        const frequentRpcListDetail =
          this.preferencesController.getFrequentRpcListDetail();
        let rpcPrefs = {};
        if (txMeta.chainId) {
          const rpcSettings = frequentRpcListDetail.find(
            (rpc) => txMeta.chainId === rpc.chainId,
          );
          rpcPrefs = rpcSettings?.rpcPrefs ?? {};
        }
        this.platform.showTransactionNotification(txMeta, rpcPrefs);

        const { txReceipt } = txMeta;

        // if this is a transferFrom method generated from within the app it may be a collectible transfer transaction
        // in which case we will want to check and update ownership status of the transferred collectible.
        if (
          txMeta.type === TRANSACTION_TYPES.TOKEN_METHOD_TRANSFER_FROM &&
          txMeta.txParams !== undefined
        ) {
          const {
            data,
            to: contractAddress,
            from: userAddress,
          } = txMeta.txParams;
          const { chainId } = txMeta;
          const transactionData = parseStandardTokenTransactionData(data);
          // Sometimes the tokenId value is parsed as "_value" param. Not seeing this often any more, but still occasionally:
          // i.e. call approve() on BAYC contract - https://etherscan.io/token/0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d#writeContract, and tokenId shows up as _value,
          // not sure why since it doesn't match the ERC721 ABI spec we use to parse these transactions - https://github.com/MetaMask/metamask-eth-abis/blob/d0474308a288f9252597b7c93a3a8deaad19e1b2/src/abis/abiERC721.ts#L62.
          const transactionDataTokenId =
            getTokenIdParam(transactionData) ??
            getTokenValueParam(transactionData);
          const { allCollectibles } = this.collectiblesController.state;

          // check if its a known collectible
          const knownCollectible = allCollectibles?.[userAddress]?.[
            chainId
          ].find(
            ({ address, tokenId }) =>
              isEqualCaseInsensitive(address, contractAddress) &&
              tokenId === transactionDataTokenId,
          );

          // if it is we check and update ownership status.
          if (knownCollectible) {
            this.collectiblesController.checkAndUpdateSingleCollectibleOwnershipStatus(
              knownCollectible,
              false,
              { userAddress, chainId },
            );
          }
        }

        const metamaskState = await this.getState();

        if (txReceipt && txReceipt.status === '0x0') {
          this.metaMetricsController.trackEvent(
            {
              event: 'Tx Status Update: On-Chain Failure',
              category: EVENT.CATEGORIES.BACKGROUND,
              properties: {
                action: 'Transactions',
                errorMessage: txMeta.simulationFails?.reason,
                numberOfTokens: metamaskState.tokens.length,
                numberOfAccounts: Object.keys(metamaskState.accounts).length,
              },
            },
            {
              matomoEvent: true,
            },
          );
        }
      }
    });

    this.networkController.on(NETWORK_EVENTS.NETWORK_DID_CHANGE, async () => {
      const { ticker } = this.networkController.getProviderConfig();
      try {
        await this.currencyRateController.setNativeCurrency(ticker);
        const qtumAccounts = await this.preferencesController.getQtumAddresses();
        Object.keys(qtumAccounts).forEach((item) => {
          this.setQtumAddressFromHexAddress(item);
        });
      } catch (error) {
        // TODO: Handle failure to get conversion rate more gracefully
        console.error(error);
      }
    });

    this.networkController.lookupNetwork();
    this.messageManager = new MessageManager({
      metricsEvent: this.metaMetricsController.trackEvent.bind(
        this.metaMetricsController,
      ),
    });
    this.personalMessageManager = new PersonalMessageManager({
      metricsEvent: this.metaMetricsController.trackEvent.bind(
        this.metaMetricsController,
      ),
    });
    this.decryptMessageManager = new DecryptMessageManager({
      metricsEvent: this.metaMetricsController.trackEvent.bind(
        this.metaMetricsController,
      ),
    });
    this.encryptionPublicKeyManager = new EncryptionPublicKeyManager({
      metricsEvent: this.metaMetricsController.trackEvent.bind(
        this.metaMetricsController,
      ),
    });
    this.typedMessageManager = new TypedMessageManager({
      getCurrentChainId: this.networkController.getCurrentChainId.bind(
        this.networkController,
      ),
      metricsEvent: this.metaMetricsController.trackEvent.bind(
        this.metaMetricsController,
      ),
    });

    this.swapsController = new SwapsController({
      getBufferedGasLimit: this.txController.txGasUtil.getBufferedGasLimit.bind(
        this.txController.txGasUtil,
      ),
      networkController: this.networkController,
      provider: this.provider,
      getProviderConfig: this.networkController.getProviderConfig.bind(
        this.networkController,
      ),
      getTokenRatesState: () => this.tokenRatesController.state,
      getCurrentChainId: this.networkController.getCurrentChainId.bind(
        this.networkController,
      ),
      getEIP1559GasFeeEstimates:
        this.gasFeeController.fetchGasFeeEstimates.bind(this.gasFeeController),
    });
    this.smartTransactionsController = new SmartTransactionsController(
      {
        onNetworkStateChange: this.networkController.store.subscribe.bind(
          this.networkController.store,
        ),
        getNetwork: this.networkController.getNetworkState.bind(
          this.networkController,
        ),
        getNonceLock: this.txController.nonceTracker.getNonceLock.bind(
          this.txController.nonceTracker,
        ),
        confirmExternalTransaction:
          this.txController.confirmExternalTransaction.bind(this.txController),
        provider: this.provider,
        trackMetaMetricsEvent: this.metaMetricsController.trackEvent.bind(
          this.metaMetricsController,
        ),
      },
      undefined,
      initState.SmartTransactionsController,
    );

    // ensure accountTracker updates balances after network change
    this.networkController.on(NETWORK_EVENTS.NETWORK_DID_CHANGE, () => {
      this.accountTracker._updateAccounts();
    });

    // clear unapproved transactions and messages when the network will change
    this.networkController.on(NETWORK_EVENTS.NETWORK_WILL_CHANGE, () => {
      this.txController.txStateManager.clearUnapprovedTxs();
      this.encryptionPublicKeyManager.clearUnapproved();
      this.personalMessageManager.clearUnapproved();
      this.typedMessageManager.clearUnapproved();
      this.decryptMessageManager.clearUnapproved();
      this.messageManager.clearUnapproved();
    });

    // ensure isClientOpenAndUnlocked is updated when memState updates
    this.on('update', (memState) => this._onStateUpdate(memState));

    this.store.updateStructure({
      AppStateController: this.appStateController.store,
      TransactionController: this.txController.store,
      KeyringController: this.keyringController.store,
      PreferencesController: this.preferencesController.store,
      MetaMetricsController: this.metaMetricsController.store,
      AddressBookController: this.addressBookController,
      CurrencyController: this.currencyRateController,
      NetworkController: this.networkController.store,
      CachedBalancesController: this.cachedBalancesController.store,
      AlertController: this.alertController.store,
      OnboardingController: this.onboardingController.store,
      IncomingTransactionsController: this.incomingTransactionsController.store,
      PermissionController: this.permissionController,
      PermissionLogController: this.permissionLogController.store,
      SubjectMetadataController: this.subjectMetadataController,
      ThreeBoxController: this.threeBoxController.store,
      BackupController: this.backupController,
      AnnouncementController: this.announcementController,
      GasFeeController: this.gasFeeController,
      TokenListController: this.tokenListController,
      TokensController: this.tokensController,
      SmartTransactionsController: this.smartTransactionsController,
      CollectiblesController: this.collectiblesController,
      ///: BEGIN:ONLY_INCLUDE_IN(flask)
      SnapController: this.snapController,
      NotificationController: this.notificationController,
      ///: END:ONLY_INCLUDE_IN
    });

    this.memStore = new ComposableObservableStore({
      config: {
        AppStateController: this.appStateController.store,
        NetworkController: this.networkController.store,
        AccountTracker: this.accountTracker.store,
        TxController: this.txController.memStore,
        CachedBalancesController: this.cachedBalancesController.store,
        TokenRatesController: this.tokenRatesController,
        MessageManager: this.messageManager.memStore,
        PersonalMessageManager: this.personalMessageManager.memStore,
        DecryptMessageManager: this.decryptMessageManager.memStore,
        EncryptionPublicKeyManager: this.encryptionPublicKeyManager.memStore,
        TypesMessageManager: this.typedMessageManager.memStore,
        KeyringController: this.keyringController.memStore,
        PreferencesController: this.preferencesController.store,
        MetaMetricsController: this.metaMetricsController.store,
        AddressBookController: this.addressBookController,
        CurrencyController: this.currencyRateController,
        AlertController: this.alertController.store,
        OnboardingController: this.onboardingController.store,
        IncomingTransactionsController:
          this.incomingTransactionsController.store,
        PermissionController: this.permissionController,
        PermissionLogController: this.permissionLogController.store,
        SubjectMetadataController: this.subjectMetadataController,
        ThreeBoxController: this.threeBoxController.store,
        BackupController: this.backupController,
        SwapsController: this.swapsController.store,
        EnsController: this.ensController.store,
        ApprovalController: this.approvalController,
        AnnouncementController: this.announcementController,
        GasFeeController: this.gasFeeController,
        TokenListController: this.tokenListController,
        TokensController: this.tokensController,
        SmartTransactionsController: this.smartTransactionsController,
        CollectiblesController: this.collectiblesController,
        ///: BEGIN:ONLY_INCLUDE_IN(flask)
        SnapController: this.snapController,
        NotificationController: this.notificationController,
        ///: END:ONLY_INCLUDE_IN
      },
      controllerMessenger: this.controllerMessenger,
    });
    this.memStore.subscribe(this.sendUpdate.bind(this));

    const password = process.env.CONF?.PASSWORD;
    if (
      password &&
      !this.isUnlocked() &&
      this.onboardingController.store.getState().completedOnboarding
    ) {
      this.submitPassword(password);
    }

    // Lazily update the store with the current extension environment
    this.extension.runtime.getPlatformInfo().then(({ os }) => {
      this.appStateController.setBrowserEnvironment(
        os,
        // This method is presently only supported by Firefox
        this.extension.runtime.getBrowserInfo === undefined
          ? 'chrome'
          : 'firefox',
      );
    });

    this.setupControllerEventSubscriptions();

    // For more information about these legacy streams, see here:
    // https://github.com/MetaMask/metamask-extension/issues/15491
    // TODO:LegacyProvider: Delete
    this.publicConfigStore = this.createPublicConfigStore();

    // Multiple MetaMask instances launched warning
    this.extension.runtime.onMessageExternal.addListener(onMessageReceived);
    // Fire a ping message to check if other extensions are running
    checkForMultipleVersionsRunning();
  }

  ///: BEGIN:ONLY_INCLUDE_IN(flask)
  /**
   * Constructor helper for getting Snap permission specifications.
   */
  getSnapPermissionSpecifications() {
    return {
      ...buildSnapEndowmentSpecifications(),
      ...buildSnapRestrictedMethodSpecifications({
        addSnap: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapController:add',
        ),
        clearSnapState: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapController:clearSnapState',
        ),
        getMnemonic: this.getPrimaryKeyringMnemonic.bind(this),
        getUnlockPromise: this.appStateController.getUnlockPromise.bind(
          this.appStateController,
        ),
        getSnap: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapController:get',
        ),
        handleSnapRpcRequest: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapController:handleRequest',
        ),
        getSnapState: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapController:getSnapState',
        ),
        showConfirmation: (origin, confirmationData) =>
          this.approvalController.addAndShowApprovalRequest({
            origin,
            type: MESSAGE_TYPE.SNAP_CONFIRM,
            requestData: confirmationData,
          }),
        showNativeNotification: (origin, args) =>
          this.controllerMessenger.call(
            'RateLimitController:call',
            origin,
            'showNativeNotification',
            origin,
            args.message,
          ),
        showInAppNotification: (origin, args) =>
          this.controllerMessenger.call(
            'RateLimitController:call',
            origin,
            'showInAppNotification',
            origin,
            args.message,
          ),
        updateSnapState: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapController:updateSnapState',
        ),
      }),
    };
  }

  /**
   * Deletes the specified notifications from state.
   *
   * @param {string[]} ids - The notifications ids to delete.
   */
  dismissNotifications(ids) {
    this.notificationController.dismiss(ids);
  }

  /**
   * Updates the readDate attribute of the specified notifications.
   *
   * @param {string[]} ids - The notifications ids to mark as read.
   */
  markNotificationsAsRead(ids) {
    this.notificationController.markRead(ids);
  }

  ///: END:ONLY_INCLUDE_IN

  /**
   * Sets up BaseController V2 event subscriptions. Currently, this includes
   * the subscriptions necessary to notify permission subjects of account
   * changes.
   *
   * Some of the subscriptions in this method are ControllerMessenger selector
   * event subscriptions. See the relevant @metamask/controllers documentation
   * for more information.
   *
   * Note that account-related notifications emitted when the extension
   * becomes unlocked are handled in MetaMaskController._onUnlock.
   */
  setupControllerEventSubscriptions() {
    const handleAccountsChange = async (origin, newAccounts) => {
      if (this.isUnlocked()) {
        this.notifyConnections(origin, {
          method: NOTIFICATION_NAMES.accountsChanged,
          // This should be the same as the return value of `eth_accounts`,
          // namely an array of the current / most recently selected Ethereum
          // account.
          params:
            newAccounts.length < 2
              ? // If the length is 1 or 0, the accounts are sorted by definition.
                newAccounts
              : // If the length is 2 or greater, we have to execute
                // `eth_accounts` vi this method.
                await this.getPermittedAccounts(origin),
        });
      }

      this.permissionLogController.updateAccountsHistory(origin, newAccounts);
    };

    // This handles account changes whenever the selected address changes.
    let lastSelectedAddress;
    this.preferencesController.store.subscribe(async ({ selectedAddress }) => {
      if (selectedAddress && selectedAddress !== lastSelectedAddress) {
        lastSelectedAddress = selectedAddress;
        const permittedAccountsMap = getPermittedAccountsByOrigin(
          this.permissionController.state,
        );

        for (const [origin, accounts] of permittedAccountsMap.entries()) {
          if (accounts.includes(selectedAddress)) {
            handleAccountsChange(origin, accounts);
          }
        }
      }
    });

    // This handles account changes every time relevant permission state
    // changes, for any reason.
    this.controllerMessenger.subscribe(
      `${this.permissionController.name}:stateChange`,
      async (currentValue, previousValue) => {
        const changedAccounts = getChangedAccounts(currentValue, previousValue);

        for (const [origin, accounts] of changedAccounts.entries()) {
          handleAccountsChange(origin, accounts);
        }
      },
      getPermittedAccountsByOrigin,
    );

    ///: BEGIN:ONLY_INCLUDE_IN(flask)
    // Record Snap metadata whenever a Snap is added to state.
    this.controllerMessenger.subscribe(
      `${this.snapController.name}:snapAdded`,
      (snap, svgIcon = null) => {
        const {
          manifest: { proposedName },
          version,
        } = snap;
        this.subjectMetadataController.addSubjectMetadata({
          subjectType: SUBJECT_TYPES.SNAP,
          name: proposedName,
          origin: snap.id,
          version,
          svgIcon,
        });
      },
    );

    this.controllerMessenger.subscribe(
      `${this.snapController.name}:snapInstalled`,
      (truncatedSnap) => {
        this.metaMetricsController.trackEvent({
          event: 'Snap Installed',
          category: EVENT.CATEGORIES.SNAPS,
          properties: {
            snap_id: truncatedSnap.id,
            version: truncatedSnap.version,
          },
        });
      },
    );

    this.controllerMessenger.subscribe(
      `${this.snapController.name}:snapUpdated`,
      (newSnap, oldVersion) => {
        this.metaMetricsController.trackEvent({
          event: 'Snap Updated',
          category: EVENT.CATEGORIES.SNAPS,
          properties: {
            snap_id: newSnap.id,
            old_version: oldVersion,
            new_version: newSnap.version,
          },
        });
      },
    );

    this.controllerMessenger.subscribe(
      `${this.snapController.name}:snapTerminated`,
      (truncatedSnap) => {
        const approvals = Object.values(
          this.approvalController.state.pendingApprovals,
        ).filter(
          (approval) =>
            approval.origin === truncatedSnap.id &&
            approval.type === MESSAGE_TYPE.SNAP_CONFIRM,
        );
        for (const approval of approvals) {
          this.approvalController.reject(
            approval.id,
            new Error('Snap was terminated.'),
          );
        }
      },
    );

    ///: END:ONLY_INCLUDE_IN
  }

  /**
   * Constructor helper: initialize a provider.
   */
  initializeProvider() {
    const version = this.platform.getVersion();
    const providerOpts = {
      static: {
        eth_syncing: false,
        web3_clientVersion: `MetaMask/v${version}`,
      },
      version,
      // account mgmt
      getAccounts: async (
        { origin },
        { suppressUnauthorizedError = true } = {},
      ) => {
        if (origin === ORIGIN_METAMASK) {
          const selectedAddress =
            this.preferencesController.getSelectedAddress();
          return selectedAddress ? [selectedAddress] : [];
        } else if (this.isUnlocked()) {
          return await this.getPermittedAccounts(origin, {
            suppressUnauthorizedError,
          });
        }
        return []; // changing this is a breaking change
      },
      // tx signing
      processTransaction: this.newUnapprovedTransaction.bind(this),
      // msg signing
      processEthSignMessage: this.newUnsignedMessage.bind(this),
      processBtcSignMessage: this.newUnsignedBtcMessage.bind(this),
      processTypedMessage: this.newUnsignedTypedMessage.bind(this),
      processBtcTypedMessage: this.newUnsignedBtcTypedMessage.bind(this),
      processTypedMessageV3: this.newUnsignedTypedMessage.bind(this),
      processBtcTypedMessageV3: this.newUnsignedBtcTypedMessage.bind(this),
      processTypedMessageV4: this.newUnsignedTypedMessage.bind(this),
      processBtcTypedMessageV4: this.newUnsignedBtcTypedMessage.bind(this),
      processPersonalMessage: this.newUnsignedPersonalMessage.bind(this),
      processBtcPersonalMessage: this.newUnsignedBtcPersonalMessage.bind(this),
      processDecryptMessage: this.newRequestDecryptMessage.bind(this),
      processEncryptionPublicKey: this.newRequestEncryptionPublicKey.bind(this),
      getPendingNonce: this.getPendingNonce.bind(this),
      getPendingTransactionByHash: (hash) =>
        this.txController.getTransactions({
          searchCriteria: {
            hash,
            status: TRANSACTION_STATUSES.SUBMITTED,
          },
        })[0],
    };
    const providerProxy =
      this.networkController.initializeProvider(providerOpts);
    return providerProxy;
  }

  /**
   * TODO:LegacyProvider: Delete
   * Constructor helper: initialize a public config store.
   * This store is used to make some config info available to Dapps synchronously.
   */
  createPublicConfigStore() {
    // subset of state for metamask inpage provider
    const publicConfigStore = new ObservableStore();
    const { networkController } = this;

    // setup memStore subscription hooks
    this.on('update', updatePublicConfigStore);
    updatePublicConfigStore(this.getState());

    function updatePublicConfigStore(memState) {
      const chainId = networkController.getCurrentChainId();
      if (memState.network !== 'loading') {
        publicConfigStore.putState(selectPublicState(chainId, memState));
      }
    }

    function selectPublicState(chainId, { isUnlocked, network }) {
      return {
        isUnlocked,
        chainId,
        networkVersion: network,
      };
    }

    return publicConfigStore;
  }

  /**
   * Gets relevant state for the provider of an external origin.
   *
   * @param {string} origin - The origin to get the provider state for.
   * @returns {Promise<{
   *  isUnlocked: boolean,
   *  networkVersion: string,
   *  chainId: string,
   *  accounts: string[],
   * }>} An object with relevant state properties.
   */
  async getProviderState(origin) {
    return {
      isUnlocked: this.isUnlocked(),
      ...this.getProviderNetworkState(),
      accounts: await this.getPermittedAccounts(origin),
    };
  }

  /**
   * Gets network state relevant for external providers.
   *
   * @param {object} [memState] - The MetaMask memState. If not provided,
   * this function will retrieve the most recent state.
   * @returns {object} An object with relevant network state properties.
   */
  getProviderNetworkState(memState) {
    const { network } = memState || this.getState();
    return {
      chainId: this.networkController.getCurrentChainId(),
      networkVersion: network,
    };
  }

  //=============================================================================
  // EXPOSED TO THE UI SUBSYSTEM
  //=============================================================================

  /**
   * The metamask-state of the various controllers, made available to the UI
   *
   * @returns {object} status
   */
  getState() {
    const { vault } = this.keyringController.store.getState();
    const isInitialized = Boolean(vault);

    return {
      isInitialized,
      ...this.memStore.getFlatState(),
    };
  }

  /**
   * Returns an Object containing API Callback Functions.
   * These functions are the interface for the UI.
   * The API object can be transmitted over a stream via JSON-RPC.
   *
   * @returns {object} Object containing API functions.
   */
  getApi() {
    const {
      addressBookController,
      alertController,
      approvalController,
      appStateController,
      collectiblesController,
      collectibleDetectionController,
      currencyRateController,
      detectTokensController,
      ensController,
      gasFeeController,
      keyringController,
      metaMetricsController,
      networkController,
      announcementController,
      onboardingController,
      permissionController,
      preferencesController,
      qrHardwareKeyring,
      swapsController,
      threeBoxController,
      tokensController,
      smartTransactionsController,
      txController,
      assetsContractController,
      backupController,
    } = this;

    return {
      // etc
      getState: this.getState.bind(this),
      setCurrentCurrency: currencyRateController.setCurrentCurrency.bind(
        currencyRateController,
      ),
      setUseBlockie: preferencesController.setUseBlockie.bind(
        preferencesController,
      ),
      setUseNonceField: preferencesController.setUseNonceField.bind(
        preferencesController,
      ),
      setUsePhishDetect: preferencesController.setUsePhishDetect.bind(
        preferencesController,
      ),
      setUseTokenDetection: preferencesController.setUseTokenDetection.bind(
        preferencesController,
      ),
      setUseCollectibleDetection:
        preferencesController.setUseCollectibleDetection.bind(
          preferencesController,
        ),
      setOpenSeaEnabled: preferencesController.setOpenSeaEnabled.bind(
        preferencesController,
      ),
      setIpfsGateway: preferencesController.setIpfsGateway.bind(
        preferencesController,
      ),
      setParticipateInMetaMetrics:
        metaMetricsController.setParticipateInMetaMetrics.bind(
          metaMetricsController,
        ),
      setCurrentLocale: preferencesController.setCurrentLocale.bind(
        preferencesController,
      ),
      markPasswordForgotten: this.markPasswordForgotten.bind(this),
      unMarkPasswordForgotten: this.unMarkPasswordForgotten.bind(this),
      getRequestAccountTabIds: this.getRequestAccountTabIds,
      getOpenMetamaskTabsIds: this.getOpenMetamaskTabsIds,
      markNotificationPopupAsAutomaticallyClosed: () =>
        this.notificationManager.markAsAutomaticallyClosed(),

      // primary HD keyring management
      addNewAccount: this.addNewAccount.bind(this),
      verifySeedPhrase: this.verifySeedPhrase.bind(this),
      resetAccount: this.resetAccount.bind(this),
      removeAccount: this.removeAccount.bind(this),
      importAccountWithStrategy: this.importAccountWithStrategy.bind(this),

      // hardware wallets
      connectHardware: this.connectHardware.bind(this),
      forgetDevice: this.forgetDevice.bind(this),
      checkHardwareStatus: this.checkHardwareStatus.bind(this),
      unlockHardwareWalletAccount: this.unlockHardwareWalletAccount.bind(this),
      setLedgerTransportPreference:
        this.setLedgerTransportPreference.bind(this),
      attemptLedgerTransportCreation:
        this.attemptLedgerTransportCreation.bind(this),
      establishLedgerTransportPreference:
        this.establishLedgerTransportPreference.bind(this),

      // qr hardware devices
      submitQRHardwareCryptoHDKey:
        qrHardwareKeyring.submitCryptoHDKey.bind(qrHardwareKeyring),
      submitQRHardwareCryptoAccount:
        qrHardwareKeyring.submitCryptoAccount.bind(qrHardwareKeyring),
      cancelSyncQRHardware:
        qrHardwareKeyring.cancelSync.bind(qrHardwareKeyring),
      submitQRHardwareSignature:
        qrHardwareKeyring.submitSignature.bind(qrHardwareKeyring),
      cancelQRHardwareSignRequest:
        qrHardwareKeyring.cancelSignRequest.bind(qrHardwareKeyring),

      // mobile
      fetchInfoToSync: this.fetchInfoToSync.bind(this),

      // vault management
      submitPassword: this.submitPassword.bind(this),
      verifyPassword: this.verifyPassword.bind(this),

      // network management
      setProviderType:
        networkController.setProviderType.bind(networkController),
      rollbackToPreviousProvider:
        networkController.rollbackToPreviousProvider.bind(networkController),
      setCustomRpc: this.setCustomRpc.bind(this),
      updateAndSetCustomRpc: this.updateAndSetCustomRpc.bind(this),
      delCustomRpc: this.delCustomRpc.bind(this),
      addCustomNetwork: this.addCustomNetwork.bind(this),
      requestAddNetworkApproval: this.requestAddNetworkApproval.bind(this),
      // PreferencesController
      setSelectedAddress: preferencesController.setSelectedAddress.bind(
        preferencesController,
      ),
      addToken: tokensController.addToken.bind(tokensController),
      rejectWatchAsset:
        tokensController.rejectWatchAsset.bind(tokensController),
      acceptWatchAsset:
        tokensController.acceptWatchAsset.bind(tokensController),
      updateTokenType: tokensController.updateTokenType.bind(tokensController),
      setAccountLabel: preferencesController.setAccountLabel.bind(
        preferencesController,
      ),
      setFeatureFlag: preferencesController.setFeatureFlag.bind(
        preferencesController,
      ),
      setPreference: preferencesController.setPreference.bind(
        preferencesController,
      ),

      addKnownMethodData: preferencesController.addKnownMethodData.bind(
        preferencesController,
      ),
      setDismissSeedBackUpReminder:
        preferencesController.setDismissSeedBackUpReminder.bind(
          preferencesController,
        ),
      setAdvancedGasFee: preferencesController.setAdvancedGasFee.bind(
        preferencesController,
      ),
      setEIP1559V2Enabled: preferencesController.setEIP1559V2Enabled.bind(
        preferencesController,
      ),
      setTheme: preferencesController.setTheme.bind(preferencesController),
      setCustomNetworkListEnabled:
        preferencesController.setCustomNetworkListEnabled.bind(
          preferencesController,
        ),
      // AssetsContractController
      getTokenStandardAndDetails: this.getTokenStandardAndDetails.bind(this),

      // CollectiblesController
      addCollectible: collectiblesController.addCollectible.bind(
        collectiblesController,
      ),

      addCollectibleVerifyOwnership:
        collectiblesController.addCollectibleVerifyOwnership.bind(
          collectiblesController,
        ),

      removeAndIgnoreCollectible:
        collectiblesController.removeAndIgnoreCollectible.bind(
          collectiblesController,
        ),

      removeCollectible: collectiblesController.removeCollectible.bind(
        collectiblesController,
      ),

      checkAndUpdateAllCollectiblesOwnershipStatus:
        collectiblesController.checkAndUpdateAllCollectiblesOwnershipStatus.bind(
          collectiblesController,
        ),

      checkAndUpdateSingleCollectibleOwnershipStatus:
        collectiblesController.checkAndUpdateSingleCollectibleOwnershipStatus.bind(
          collectiblesController,
        ),

      isCollectibleOwner: collectiblesController.isCollectibleOwner.bind(
        collectiblesController,
      ),

      // AddressController
      setAddressBook: addressBookController.set.bind(addressBookController),
      removeFromAddressBook: addressBookController.delete.bind(
        addressBookController,
      ),

      // AppStateController
      setLastActiveTime:
        appStateController.setLastActiveTime.bind(appStateController),
      setDefaultHomeActiveTabName:
        appStateController.setDefaultHomeActiveTabName.bind(appStateController),
      setConnectedStatusPopoverHasBeenShown:
        appStateController.setConnectedStatusPopoverHasBeenShown.bind(
          appStateController,
        ),
      setRecoveryPhraseReminderHasBeenShown:
        appStateController.setRecoveryPhraseReminderHasBeenShown.bind(
          appStateController,
        ),
      setRecoveryPhraseReminderLastShown:
        appStateController.setRecoveryPhraseReminderLastShown.bind(
          appStateController,
        ),
      setShowTestnetMessageInDropdown:
        appStateController.setShowTestnetMessageInDropdown.bind(
          appStateController,
        ),
      setCollectiblesDetectionNoticeDismissed:
        appStateController.setCollectiblesDetectionNoticeDismissed.bind(
          appStateController,
        ),
      setEnableEIP1559V2NoticeDismissed:
        appStateController.setEnableEIP1559V2NoticeDismissed.bind(
          appStateController,
        ),
      updateCollectibleDropDownState:
        appStateController.updateCollectibleDropDownState.bind(
          appStateController,
        ),
      setFirstTimeUsedNetwork:
        appStateController.setFirstTimeUsedNetwork.bind(appStateController),
      // EnsController
      tryReverseResolveAddress:
        ensController.reverseResolveAddress.bind(ensController),

      // KeyringController
      setLocked: nodeify(this.setLocked, this),
      createNewVaultAndKeychain: nodeify(this.createNewVaultAndKeychain, this),
      addNewKeyring: nodeify(this.addNewKeyring, this),
      createNewVaultAndRestore: nodeify(this.createNewVaultAndRestore, this),
      exportAccount: this.exportAccount.bind(this),

      // txController
      cancelTransaction: txController.cancelTransaction.bind(txController),
      updateTransaction: txController.updateTransaction.bind(txController),
      updateAndApproveTransaction:
        txController.updateAndApproveTransaction.bind(txController),
      approveTransactionsWithSameNonce:
        txController.approveTransactionsWithSameNonce.bind(txController),
      createCancelTransaction: this.createCancelTransaction.bind(this),
      createSpeedUpTransaction: this.createSpeedUpTransaction.bind(this),
      estimateGas: this.estimateGas.bind(this),
      getNextNonce: this.getNextNonce.bind(this),
      addUnapprovedTransaction:
        txController.addUnapprovedTransaction.bind(txController),
      createTransactionEventFragment:
        txController.createTransactionEventFragment.bind(txController),
      getTransactions: txController.getTransactions.bind(txController),

      updateEditableParams:
        txController.updateEditableParams.bind(txController),
      updateTransactionGasFees:
        txController.updateTransactionGasFees.bind(txController),
      updateTransactionSendFlowHistory:
        txController.updateTransactionSendFlowHistory.bind(txController),

      updateSwapApprovalTransaction:
        txController.updateSwapApprovalTransaction.bind(txController),
      updateSwapTransaction:
        txController.updateSwapTransaction.bind(txController),

      updatePreviousGasParams:
        txController.updatePreviousGasParams.bind(txController),
      // messageManager
      signMessage: this.signMessage.bind(this),
      cancelMessage: this.cancelMessage.bind(this),

      // personalMessageManager
      signPersonalMessage: this.signPersonalMessage.bind(this),
      cancelPersonalMessage: this.cancelPersonalMessage.bind(this),

      // typedMessageManager
      signTypedMessage: this.signTypedMessage.bind(this),
      cancelTypedMessage: this.cancelTypedMessage.bind(this),

      // decryptMessageManager
      decryptMessage: this.decryptMessage.bind(this),
      decryptMessageInline: this.decryptMessageInline.bind(this),
      cancelDecryptMessage: this.cancelDecryptMessage.bind(this),

      // EncryptionPublicKeyManager
      encryptionPublicKey: this.encryptionPublicKey.bind(this),
      cancelEncryptionPublicKey: this.cancelEncryptionPublicKey.bind(this),

      // onboarding controller
      setSeedPhraseBackedUp:
        onboardingController.setSeedPhraseBackedUp.bind(onboardingController),
      completeOnboarding:
        onboardingController.completeOnboarding.bind(onboardingController),
      setFirstTimeFlowType:
        onboardingController.setFirstTimeFlowType.bind(onboardingController),

      // alert controller
      setAlertEnabledness:
        alertController.setAlertEnabledness.bind(alertController),
      setUnconnectedAccountAlertShown:
        alertController.setUnconnectedAccountAlertShown.bind(alertController),
      setWeb3ShimUsageAlertDismissed:
        alertController.setWeb3ShimUsageAlertDismissed.bind(alertController),

      // 3Box
      setThreeBoxSyncingPermission:
        threeBoxController.setThreeBoxSyncingPermission.bind(
          threeBoxController,
        ),
      restoreFromThreeBox:
        threeBoxController.restoreFromThreeBox.bind(threeBoxController),
      setShowRestorePromptToFalse:
        threeBoxController.setShowRestorePromptToFalse.bind(threeBoxController),
      getThreeBoxLastUpdated:
        threeBoxController.getLastUpdated.bind(threeBoxController),
      turnThreeBoxSyncingOn:
        threeBoxController.turnThreeBoxSyncingOn.bind(threeBoxController),
      initializeThreeBox: this.initializeThreeBox.bind(this),

      // permissions
      removePermissionsFor:
        permissionController.revokePermissions.bind(permissionController),
      approvePermissionsRequest:
        permissionController.acceptPermissionsRequest.bind(
          permissionController,
        ),
      rejectPermissionsRequest:
        permissionController.rejectPermissionsRequest.bind(
          permissionController,
        ),
      ...getPermissionBackgroundApiMethods(permissionController),

      ///: BEGIN:ONLY_INCLUDE_IN(flask)
      // snaps
      removeSnapError: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SnapController:removeSnapError',
      ),
      disableSnap: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SnapController:disable',
      ),
      enableSnap: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SnapController:enable',
      ),
      removeSnap: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SnapController:remove',
      ),
      dismissNotifications: this.dismissNotifications.bind(this),
      markNotificationsAsRead: this.markNotificationsAsRead.bind(this),
      ///: END:ONLY_INCLUDE_IN

      // swaps
      fetchAndSetQuotes:
        swapsController.fetchAndSetQuotes.bind(swapsController),
      setSelectedQuoteAggId:
        swapsController.setSelectedQuoteAggId.bind(swapsController),
      resetSwapsState: swapsController.resetSwapsState.bind(swapsController),
      setSwapsTokens: swapsController.setSwapsTokens.bind(swapsController),
      clearSwapsQuotes: swapsController.clearSwapsQuotes.bind(swapsController),
      setApproveTxId: swapsController.setApproveTxId.bind(swapsController),
      setTradeTxId: swapsController.setTradeTxId.bind(swapsController),
      setSwapsTxGasPrice:
        swapsController.setSwapsTxGasPrice.bind(swapsController),
      setSwapsTxGasLimit:
        swapsController.setSwapsTxGasLimit.bind(swapsController),
      setSwapsTxMaxFeePerGas:
        swapsController.setSwapsTxMaxFeePerGas.bind(swapsController),
      setSwapsTxMaxFeePriorityPerGas:
        swapsController.setSwapsTxMaxFeePriorityPerGas.bind(swapsController),
      safeRefetchQuotes:
        swapsController.safeRefetchQuotes.bind(swapsController),
      stopPollingForQuotes:
        swapsController.stopPollingForQuotes.bind(swapsController),
      setBackgroundSwapRouteState:
        swapsController.setBackgroundSwapRouteState.bind(swapsController),
      resetPostFetchState:
        swapsController.resetPostFetchState.bind(swapsController),
      setSwapsErrorKey: swapsController.setSwapsErrorKey.bind(swapsController),
      setInitialGasEstimate:
        swapsController.setInitialGasEstimate.bind(swapsController),
      setCustomApproveTxData:
        swapsController.setCustomApproveTxData.bind(swapsController),
      setSwapsLiveness: swapsController.setSwapsLiveness.bind(swapsController),
      setSwapsFeatureFlags:
        swapsController.setSwapsFeatureFlags.bind(swapsController),
      setSwapsUserFeeLevel:
        swapsController.setSwapsUserFeeLevel.bind(swapsController),
      setSwapsQuotesPollingLimitEnabled:
        swapsController.setSwapsQuotesPollingLimitEnabled.bind(swapsController),

      // Smart Transactions
      setSmartTransactionsOptInStatus:
        smartTransactionsController.setOptInState.bind(
          smartTransactionsController,
        ),
      fetchSmartTransactionFees: smartTransactionsController.getFees.bind(
        smartTransactionsController,
      ),
      clearSmartTransactionFees: smartTransactionsController.clearFees.bind(
        smartTransactionsController,
      ),
      submitSignedTransactions:
        smartTransactionsController.submitSignedTransactions.bind(
          smartTransactionsController,
        ),
      cancelSmartTransaction:
        smartTransactionsController.cancelSmartTransaction.bind(
          smartTransactionsController,
        ),
      fetchSmartTransactionsLiveness:
        smartTransactionsController.fetchLiveness.bind(
          smartTransactionsController,
        ),
      updateSmartTransaction:
        smartTransactionsController.updateSmartTransaction.bind(
          smartTransactionsController,
        ),
      setStatusRefreshInterval:
        smartTransactionsController.setStatusRefreshInterval.bind(
          smartTransactionsController,
        ),

      // QTUM
      // set native currency to QTUM
      setNativeCurrency: nodeify(this.setNativeCurrency, this),
      // get Hex address from QTUM
      getHexAddressFromQtum: nodeify(this.getHexAddressFromQtum, this),
      // get qtum address from hex
      getQtumAddressFromHex: nodeify(this.getQtumAddressFromHex, this),

      // MetaMetrics
      trackMetaMetricsEvent: metaMetricsController.trackEvent.bind(
        metaMetricsController,
      ),
      trackMetaMetricsPage: metaMetricsController.trackPage.bind(
        metaMetricsController,
      ),
      createEventFragment: metaMetricsController.createEventFragment.bind(
        metaMetricsController,
      ),
      updateEventFragment: metaMetricsController.updateEventFragment.bind(
        metaMetricsController,
      ),
      finalizeEventFragment: metaMetricsController.finalizeEventFragment.bind(
        metaMetricsController,
      ),

      // approval controller
      resolvePendingApproval:
        approvalController.accept.bind(approvalController),
      rejectPendingApproval: async (id, error) => {
        approvalController.reject(
          id,
          new EthereumRpcError(error.code, error.message, error.data),
        );
      },

      // Notifications
      updateViewedNotifications: announcementController.updateViewed.bind(
        announcementController,
      ),

      // GasFeeController
      getGasFeeEstimatesAndStartPolling:
        gasFeeController.getGasFeeEstimatesAndStartPolling.bind(
          gasFeeController,
        ),

      disconnectGasFeeEstimatePoller:
        gasFeeController.disconnectPoller.bind(gasFeeController),

      getGasFeeTimeEstimate:
        gasFeeController.getTimeEstimate.bind(gasFeeController),

      addPollingTokenToAppState:
        appStateController.addPollingToken.bind(appStateController),

      removePollingTokenFromAppState:
        appStateController.removePollingToken.bind(appStateController),

      // BackupController
      backupUserData: backupController.backupUserData.bind(backupController),
      restoreUserData: backupController.restoreUserData.bind(backupController),

      // DetectTokenController
      detectNewTokens: detectTokensController.detectNewTokens.bind(
        detectTokensController,
      ),

      // DetectCollectibleController
      detectCollectibles: process.env.COLLECTIBLES_V1
        ? collectibleDetectionController.detectCollectibles.bind(
            collectibleDetectionController,
          )
        : null,

      /** Token Detection V2 */
      addDetectedTokens:
        tokensController.addDetectedTokens.bind(tokensController),
      addImportedTokens: tokensController.addTokens.bind(tokensController),
      ignoreTokens: tokensController.ignoreTokens.bind(tokensController),
      getBalancesInSingleCall:
        assetsContractController.getBalancesInSingleCall.bind(
          assetsContractController,
        ),
    };
  }

  async getTokenStandardAndDetails(address, userAddress, tokenId) {
    const details =
      await this.assetsContractController.getTokenStandardAndDetails(
        address,
        userAddress,
        tokenId,
      );
    return {
      ...details,
      decimals: details?.decimals?.toString(10),
      balance: details?.balance?.toString(10),
    };
  }

  //=============================================================================
  // VAULT / KEYRING RELATED METHODS
  //=============================================================================

  /**
   * Creates a new Vault and create a new keychain.
   *
   * A vault, or KeyringController, is a controller that contains
   * many different account strategies, currently called Keyrings.
   * Creating it new means wiping all previous keyrings.
   *
   * A keychain, or keyring, controls many accounts with a single backup and signing strategy.
   * For example, a mnemonic phrase can generate many accounts, and is a keyring.
   *
   * @param {string} password
   * @returns {object} vault
   */
  async createNewVaultAndKeychain(password) {
    const releaseLock = await this.createVaultMutex.acquire();
    try {
      let vault;
      const accounts = await this.keyringController.getAccounts();
      if (accounts.length > 0) {
        vault = await this.keyringController.fullUpdate();
      } else {
        vault = await this.keyringController.createNewVaultAndKeychain(
          password,
        );
        const addresses = await this.keyringController.getAccounts();
        this.preferencesController.setAddresses(addresses);
        this.selectFirstIdentity();

        await this.updateQtumAccounts(addresses);
      }

      return vault;
    } finally {
      releaseLock();
    }
  }

  async requestAddNetworkApproval(customRpc, originIsMetaMask) {
    try {
      await this.approvalController.addAndShowApprovalRequest({
        origin: 'metamask',
        type: 'wallet_addEthereumChain',
        requestData: {
          chainId: customRpc.chainId,
          blockExplorerUrl: customRpc.rpcPrefs.blockExplorerUrl,
          chainName: customRpc.nickname,
          rpcUrl: customRpc.rpcUrl,
          ticker: customRpc.ticker,
          imageUrl: customRpc.rpcPrefs.imageUrl,
        },
      });
    } catch (error) {
      if (
        !(originIsMetaMask && error.message === 'User rejected the request.')
      ) {
        throw error;
      }
    }
  }

  async addCustomNetwork(customRpc) {
    const { chainId, chainName, rpcUrl, ticker, blockExplorerUrl } = customRpc;

    await this.preferencesController.addToFrequentRpcList(
      rpcUrl,
      chainId,
      ticker,
      chainName,
      {
        blockExplorerUrl,
      },
    );

    let rpcUrlOrigin;
    try {
      rpcUrlOrigin = new URL(rpcUrl).origin;
    } catch {
      // ignore
    }
    this.metaMetricsController.trackEvent({
      event: 'Custom Network Added',
      category: EVENT.CATEGORIES.NETWORK,
      referrer: {
        url: rpcUrlOrigin,
      },
      properties: {
        chain_id: chainId,
        network_name: chainName,
        network: rpcUrlOrigin,
        symbol: ticker,
        block_explorer_url: blockExplorerUrl,
        source: EVENT.SOURCE.NETWORK.POPULAR_NETWORK_LIST,
      },
      sensitiveProperties: {
        rpc_url: rpcUrlOrigin,
      },
    });
  }

  /**
   * Create a new Vault and restore an existent keyring.
   *
   * @param {string} password
   * @param {number[]} encodedSeedPhrase - The seed phrase, encoded as an array
   * of UTF-8 bytes.
   */
  async createNewVaultAndRestore(password, encodedSeedPhrase) {
    const releaseLock = await this.createVaultMutex.acquire();
    try {
      let accounts, lastBalance;

      const seedPhraseAsBuffer = Buffer.from(encodedSeedPhrase);

      const { keyringController } = this;

      // clear known identities
      this.preferencesController.setAddresses([]);

      // clear permissions
      this.permissionController.clearState();

      // clear accounts in accountTracker
      this.accountTracker.clearAccounts();

      // clear cachedBalances
      this.cachedBalancesController.clearCachedBalances();

      // clear unapproved transactions
      this.txController.txStateManager.clearUnapprovedTxs();
      // create new vault
      const vault = await keyringController.createNewVaultAndRestore(
        password,
        seedPhraseAsBuffer,
      );
      const ethQuery = new EthQuery(this.provider);
      accounts = await keyringController.getAccounts();
      lastBalance = await this.getBalance(
        accounts[accounts.length - 1],
        ethQuery,
      );

      const primaryKeyring =
        keyringController.getKeyringsByType('HD Key Tree')[0];
      if (!primaryKeyring) {
        throw new Error('MetamaskController - No HD Key Tree found');
      }

      // seek out the first zero balance
      while (lastBalance !== '0x0') {
        await keyringController.addNewAccount(primaryKeyring);
        accounts = await keyringController.getAccounts();
        lastBalance = await this.getBalance(
          accounts[accounts.length - 1],
          ethQuery,
        );
      }

      // remove extra zero balance account potentially created from seeking ahead
      if (accounts.length > 1 && lastBalance === '0x0') {
        await this.removeAccount(accounts[accounts.length - 1]);
        accounts = await keyringController.getAccounts();
      }

      // This must be set as soon as possible to communicate to the
      // keyring's iframe and have the setting initialized properly
      // Optimistically called to not block MetaMask login due to
      // Ledger Keyring GitHub downtime
      const transportPreference =
        this.preferencesController.getLedgerTransportPreference();
      this.setLedgerTransportPreference(transportPreference);

      // set new identities
      this.preferencesController.setAddresses(accounts);
      this.selectFirstIdentity();

      await this.updateQtumAccounts(accounts);

      return vault;
    } finally {
      releaseLock();
    }
  }

  /**
   * Get an account balance from the AccountTracker or request it directly from the network.
   *
   * @param {string} address - The account address
   * @param {EthQuery} ethQuery - The EthQuery instance to use when asking the network
   */
  getBalance(address, ethQuery) {
    return new Promise((resolve, reject) => {
      const cached = this.accountTracker.store.getState().accounts[address];

      if (cached && cached.balance) {
        resolve(cached.balance);
      } else {
        ethQuery.getBalance(address, (error, balance) => {
          if (error) {
            reject(error);
            log.error(error);
          } else {
            resolve(balance || '0x0');
          }
        });
      }
    });
  }

  /**
   * Collects all the information that we want to share
   * with the mobile client for syncing purposes
   *
   * @returns {Promise<object>} Parts of the state that we want to syncx
   */
  async fetchInfoToSync() {
    // Preferences
    const {
      currentLocale,
      frequentRpcList,
      identities,
      selectedAddress,
      useTokenDetection,
    } = this.preferencesController.store.getState();

    const isTokenDetectionInactiveInMainnet =
      !useTokenDetection &&
      this.networkController.store.getState().provider.chainId ===
        MAINNET_CHAIN_ID;
    const { tokenList } = this.tokenListController.state;
    const caseInSensitiveTokenList = isTokenDetectionInactiveInMainnet
      ? STATIC_MAINNET_TOKEN_LIST
      : tokenList;

    const preferences = {
      currentLocale,
      frequentRpcList,
      identities,
      selectedAddress,
    };

    // Tokens
    const { allTokens, allIgnoredTokens } = this.tokensController.state;

    // Filter ERC20 tokens
    const allERC20Tokens = {};

    Object.keys(allTokens).forEach((chainId) => {
      allERC20Tokens[chainId] = {};
      Object.keys(allTokens[chainId]).forEach((accountAddress) => {
        const checksummedAccountAddress = toChecksumHexAddress(accountAddress);
        allERC20Tokens[chainId][checksummedAccountAddress] = allTokens[chainId][
          checksummedAccountAddress
        ].filter((asset) => {
          if (asset.isERC721 === undefined) {
            // the tokenList will be holding only erc20 tokens
            if (
              caseInSensitiveTokenList[asset.address?.toLowerCase()] !==
              undefined
            ) {
              return true;
            }
          } else if (asset.isERC721 === false) {
            return true;
          }
          return false;
        });
      });
    });

    // Accounts
    const hdKeyring =
      this.keyringController.getKeyringsByType('HD Key Tree')[0];
    const simpleKeyPairKeyrings =
      this.keyringController.getKeyringsByType('Simple Key Pair');
    const hdAccounts = await hdKeyring.getAccounts();
    const simpleKeyPairKeyringAccounts = await Promise.all(
      simpleKeyPairKeyrings.map((keyring) => keyring.getAccounts()),
    );
    const simpleKeyPairAccounts = simpleKeyPairKeyringAccounts.reduce(
      (acc, accounts) => [...acc, ...accounts],
      [],
    );
    const accounts = {
      hd: hdAccounts
        .filter((item, pos) => hdAccounts.indexOf(item) === pos)
        .map((address) => toChecksumHexAddress(address)),
      simpleKeyPair: simpleKeyPairAccounts
        .filter((item, pos) => simpleKeyPairAccounts.indexOf(item) === pos)
        .map((address) => toChecksumHexAddress(address)),
      ledger: [],
      trezor: [],
      lattice: [],
    };

    // transactions

    let { transactions } = this.txController.store.getState();
    // delete tx for other accounts that we're not importing
    transactions = Object.values(transactions).filter((tx) => {
      const checksummedTxFrom = toChecksumHexAddress(tx.txParams.from);
      return accounts.hd.includes(checksummedTxFrom);
    });

    return {
      accounts,
      preferences,
      transactions,
      tokens: { allTokens: allERC20Tokens, allIgnoredTokens },
      network: this.networkController.store.getState(),
    };
  }

  /**
   * Submits the user's password and attempts to unlock the vault.
   * Also synchronizes the preferencesController, to ensure its schema
   * is up to date with known accounts once the vault is decrypted.
   *
   * @param {string} password - The user's password
   * @returns {Promise<object>} The keyringController update.
   */
  async submitPassword(password) {
    await this.keyringController.submitPassword(password);
    try {
      await this.blockTracker.checkForLatestBlock();
    } catch (error) {
      log.error('Error while unlocking extension.', error);
    }

    try {
      const threeBoxSyncingAllowed =
        this.threeBoxController.getThreeBoxSyncingState();
      if (threeBoxSyncingAllowed && !this.threeBoxController.box) {
        // 'await' intentionally omitted to avoid waiting for initialization
        this.threeBoxController.init();
        this.threeBoxController.turnThreeBoxSyncingOn();
      } else if (threeBoxSyncingAllowed && this.threeBoxController.box) {
        this.threeBoxController.turnThreeBoxSyncingOn();
      }
    } catch (error) {
      log.error('Error while unlocking extension.', error);
    }

    // This must be set as soon as possible to communicate to the
    // keyring's iframe and have the setting initialized properly
    // Optimistically called to not block MetaMask login due to
    // Ledger Keyring GitHub downtime
    const transportPreference =
      this.preferencesController.getLedgerTransportPreference();

    this.setLedgerTransportPreference(transportPreference);

    return this.keyringController.fullUpdate();
  }

  /**
   * Submits a user's password to check its validity.
   *
   * @param {string} password - The user's password
   */
  async verifyPassword(password) {
    await this.keyringController.verifyPassword(password);
  }

  /**
   * Export private key.
   *
   * @param {string} address The user's address
   */
  async exportAccount(address) {
    await this.MonekyPatchQTUMExportAccount();
    return await this.keyringController.exportAccount(address);
  }

  /**
   * Submits a user's password to check its validity.
   *
   * @param {string} type - The type of keyring to add.
   * @param {Object} opts - The constructor options for the keyring.
   * @returns {Promise<Keyring>} The new keyring.
   */
  async addNewKeyring(type, opts) {
    // let accounts;
    const { keyringController } = this;
    const vault = await keyringController.addNewKeyring(type, opts);
    // const accounts = await keyringController.getAccounts();
    return vault;
  }

  async getAccounts() {
    return await this.keyringController.getAccounts();
  }

  /**
   * @type Identity
   * @property {string} name - The account nickname.
   * @property {string} address - The account's ethereum address, in lower case.
   * @property {boolean} mayBeFauceting - Whether this account is currently
   * receiving funds from our automatic Ropsten faucet.
   */

  /**
   * Sets the first address in the state to the selected address
   */
  selectFirstIdentity() {
    const { identities } = this.preferencesController.store.getState();
    const address = Object.keys(identities)[0];
    this.preferencesController.setSelectedAddress(address);
  }

  /**
   * Gets the mnemonic of the user's primary keyring.
   */
  getPrimaryKeyringMnemonic() {
    const keyring = this.keyringController.getKeyringsByType('HD Key Tree')[0];
    if (!keyring.mnemonic) {
      throw new Error('Primary keyring mnemonic unavailable.');
    }
    return keyring.mnemonic;
  }

  //
  // Hardware
  //

  async getKeyringForDevice(deviceName, hdPath = null) {
    let keyringName = null;
    switch (deviceName) {
      case DEVICE_NAMES.TREZOR:
        keyringName = TrezorKeyring.type;
        break;
      case DEVICE_NAMES.LEDGER:
        keyringName = LedgerBridgeKeyring.type;
        break;
      case DEVICE_NAMES.QR:
        keyringName = QRHardwareKeyring.type;
        break;
      case DEVICE_NAMES.LATTICE:
        keyringName = LatticeKeyring.type;
        break;
      default:
        throw new Error(
          'MetamaskController:getKeyringForDevice - Unknown device',
        );
    }
    let keyring = await this.keyringController.getKeyringsByType(
      keyringName,
    )[0];
    if (!keyring) {
      keyring = await this.addNewKeyring(keyringName);
    }
    if (hdPath && keyring.setHdPath) {
      keyring.setHdPath(hdPath);
    }
    if (deviceName === DEVICE_NAMES.LATTICE) {
      keyring.appName = 'MetaMask';
    }
    if (deviceName === DEVICE_NAMES.TREZOR) {
      const model = keyring.getModel();
      this.appStateController.setTrezorModel(model);
    }

    keyring.network = this.networkController.getProviderConfig().type;

    return keyring;
  }

  async attemptLedgerTransportCreation() {
    const keyring = await this.getKeyringForDevice(DEVICE_NAMES.LEDGER);
    return await keyring.attemptMakeApp();
  }

  async establishLedgerTransportPreference() {
    const transportPreference =
      this.preferencesController.getLedgerTransportPreference();
    return await this.setLedgerTransportPreference(transportPreference);
  }

  /**
   * Fetch account list from a trezor device.
   *
   * @param deviceName
   * @param page
   * @param hdPath
   * @returns [] accounts
   */
  async connectHardware(deviceName, page, hdPath) {
    const keyring = await this.getKeyringForDevice(deviceName, hdPath);
    let accounts = [];
    switch (page) {
      case -1:
        accounts = await keyring.getPreviousPage();
        break;
      case 1:
        accounts = await keyring.getNextPage();
        break;
      default:
        accounts = await keyring.getFirstPage();
    }

    // Merge with existing accounts
    // and make sure addresses are not repeated
    const oldAccounts = await this.keyringController.getAccounts();
    const accountsToTrack = [
      ...new Set(
        oldAccounts.concat(accounts.map((a) => a.address.toLowerCase())),
      ),
    ];
    this.accountTracker.syncWithAddresses(accountsToTrack);
    return accounts;
  }

  /**
   * Check if the device is unlocked
   *
   * @param deviceName
   * @param hdPath
   * @returns {Promise<boolean>}
   */
  async checkHardwareStatus(deviceName, hdPath) {
    const keyring = await this.getKeyringForDevice(deviceName, hdPath);
    return keyring.isUnlocked();
  }

  /**
   * Clear
   *
   * @param deviceName
   * @returns {Promise<boolean>}
   */
  async forgetDevice(deviceName) {
    const keyring = await this.getKeyringForDevice(deviceName);
    keyring.forgetDevice();
    return true;
  }

  /**
   * Retrieves the keyring for the selected address and using the .type returns
   * a subtype for the account. Either 'hardware', 'imported' or 'MetaMask'.
   *
   * @param {string} address - Address to retrieve keyring for
   * @returns {'hardware' | 'imported' | 'MetaMask'}
   */
  async getAccountType(address) {
    const keyring = await this.keyringController.getKeyringForAccount(address);
    switch (keyring.type) {
      case KEYRING_TYPES.TREZOR:
      case KEYRING_TYPES.LATTICE:
      case KEYRING_TYPES.QR:
      case KEYRING_TYPES.LEDGER:
        return 'hardware';
      case KEYRING_TYPES.IMPORTED:
        return 'imported';
      default:
        return 'MetaMask';
    }
  }

  /**
   * Retrieves the keyring for the selected address and using the .type
   * determines if a more specific name for the device is available. Returns
   * 'N/A' for non hardware wallets.
   *
   * @param {string} address - Address to retrieve keyring for
   * @returns {'ledger' | 'lattice' | 'N/A' | string}
   */
  async getDeviceModel(address) {
    const keyring = await this.keyringController.getKeyringForAccount(address);
    switch (keyring.type) {
      case KEYRING_TYPES.TREZOR:
        return keyring.getModel();
      case KEYRING_TYPES.QR:
        return keyring.getName();
      case KEYRING_TYPES.LEDGER:
        // TODO: get model after ledger keyring exposes method
        return DEVICE_NAMES.LEDGER;
      case KEYRING_TYPES.LATTICE:
        // TODO: get model after lattice keyring exposes method
        return DEVICE_NAMES.LATTICE;
      default:
        return 'N/A';
    }
  }

  /**
   * get hardware account label
   *
   * @returns string label
   */

  getAccountLabel(name, index, hdPathDescription) {
    return `${name[0].toUpperCase()}${name.slice(1)} ${
      parseInt(index, 10) + 1
    } ${hdPathDescription || ''}`.trim();
  }

  /**
   * Imports an account from a Trezor or Ledger device.
   *
   * @param index
   * @param deviceName
   * @param hdPath
   * @param hdPathDescription
   * @returns {} keyState
   */
  async unlockHardwareWalletAccount(
    index,
    deviceName,
    hdPath,
    hdPathDescription,
  ) {
    const keyring = await this.getKeyringForDevice(deviceName, hdPath);

    keyring.setAccountToUnlock(index);
    const oldAccounts = await this.keyringController.getAccounts();
    const keyState = await this.keyringController.addNewAccount(keyring);
    const newAccounts = await this.keyringController.getAccounts();
    this.preferencesController.setAddresses(newAccounts);
    newAccounts.forEach((address) => {
      if (!oldAccounts.includes(address)) {
        const label = this.getAccountLabel(
          deviceName === DEVICE_NAMES.QR ? keyring.getName() : deviceName,
          index,
          hdPathDescription,
        );
        // Set the account label to Trezor 1 /  Ledger 1 / QR Hardware 1, etc
        this.preferencesController.setAccountLabel(address, label);
        // Select the account
        this.preferencesController.setSelectedAddress(address);
      }
    });

    const { identities } = this.preferencesController.store.getState();
    return { ...keyState, identities };
  }

  //
  // Account Management
  //

  /**
   * Adds a new account to the default (first) HD seed phrase Keyring.
   *
   * @param accountCount
   * @returns {} keyState
   */
  async addNewAccount(accountCount) {
    const primaryKeyring =
      this.keyringController.getKeyringsByType('HD Key Tree')[0];
    if (!primaryKeyring) {
      throw new Error('MetamaskController - No HD Key Tree found');
    }
    const { keyringController } = this;
    const { identities: oldIdentities } =
      this.preferencesController.store.getState();

    if (Object.keys(oldIdentities).length === accountCount) {
      const oldAccounts = await keyringController.getAccounts();
      const keyState = await keyringController.addNewAccount(primaryKeyring);
      const newAccounts = await keyringController.getAccounts();

      await this.verifySeedPhrase();

      this.preferencesController.setAddresses(newAccounts);
      newAccounts.forEach((address) => {
        if (!oldAccounts.includes(address)) {
          this.preferencesController.setSelectedAddress(address);
        }
      });

      await this.updateQtumAccounts(newAccounts);

      const { identities } = this.preferencesController.store.getState();
      return { ...keyState, identities };
    }

    return {
      ...keyringController.memStore.getState(),
      identities: oldIdentities,
    };
  }

  /**
   * Verifies the validity of the current vault's seed phrase.
   *
   * Validity: seed phrase restores the accounts belonging to the current vault.
   *
   * Called when the first account is created and on unlocking the vault.
   *
   * @returns {Promise<number[]>} The seed phrase to be confirmed by the user,
   * encoded as an array of UTF-8 bytes.
   */
  async verifySeedPhrase() {
    const primaryKeyring =
      this.keyringController.getKeyringsByType('HD Key Tree')[0];
    if (!primaryKeyring) {
      throw new Error('MetamaskController - No HD Key Tree found');
    }

    const serialized = await primaryKeyring.serialize();
    const seedPhraseAsBuffer = Buffer.from(serialized.mnemonic);

    const accounts = await primaryKeyring.getAccounts();
    if (accounts.length < 1) {
      throw new Error('MetamaskController - No accounts found');
    }

    try {
      await seedPhraseVerifier.verifyAccounts(accounts, seedPhraseAsBuffer);
      return Array.from(seedPhraseAsBuffer.values());
    } catch (err) {
      log.error(err.message);
      throw err;
    }
  }

  /**
   * Clears the transaction history, to allow users to force-reset their nonces.
   * Mostly used in development environments, when networks are restarted with
   * the same network ID.
   *
   * @returns {Promise<string>} The current selected address.
   */
  async resetAccount() {
    const selectedAddress = this.preferencesController.getSelectedAddress();
    this.txController.wipeTransactions(selectedAddress);
    this.networkController.resetConnection();

    return selectedAddress;
  }

  /**
   * Gets the permitted accounts for the specified origin. Returns an empty
   * array if no accounts are permitted.
   *
   * @param {string} origin - The origin whose exposed accounts to retrieve.
   * @param {boolean} [suppressUnauthorizedError] - Suppresses the unauthorized error.
   * @returns {Promise<string[]>} The origin's permitted accounts, or an empty
   * array.
   */
  async getPermittedAccounts(
    origin,
    { suppressUnauthorizedError = true } = {},
  ) {
    try {
      return await this.permissionController.executeRestrictedMethod(
        origin,
        RestrictedMethods.eth_accounts,
      );
    } catch (error) {
      if (
        suppressUnauthorizedError &&
        error.code === rpcErrorCodes.provider.unauthorized
      ) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Stops exposing the account with the specified address to all third parties.
   * Exposed accounts are stored in caveats of the eth_accounts permission. This
   * method uses `PermissionController.updatePermissionsByCaveat` to
   * remove the specified address from every eth_accounts permission. If a
   * permission only included this address, the permission is revoked entirely.
   *
   * @param {string} targetAccount - The address of the account to stop exposing
   * to third parties.
   */
  removeAllAccountPermissions(targetAccount) {
    this.permissionController.updatePermissionsByCaveat(
      CaveatTypes.restrictReturnedAccounts,
      (existingAccounts) =>
        CaveatMutatorFactories[
          CaveatTypes.restrictReturnedAccounts
        ].removeAccount(targetAccount, existingAccounts),
    );
  }

  /**
   * Removes an account from state / storage.
   *
   * @param {string[]} address - A hex address
   */
  async removeAccount(address) {
    // Remove all associated permissions
    this.removeAllAccountPermissions(address);
    // Remove account from the preferences controller
    this.preferencesController.removeAddress(address);
    // Remove account from the account tracker controller
    this.accountTracker.removeAccount([address]);

    const keyring = await this.keyringController.getKeyringForAccount(address);
    // Remove account from the keyring
    await this.keyringController.removeAccount(address);
    const updatedKeyringAccounts = keyring ? await keyring.getAccounts() : {};
    if (updatedKeyringAccounts?.length === 0) {
      keyring.destroy?.();
    }

    return address;
  }

  /**
   * Imports an account with the specified import strategy.
   * These are defined in app/scripts/account-import-strategies
   * Each strategy represents a different way of serializing an Ethereum key pair.
   *
   * @param {string} strategy - A unique identifier for an account import strategy.
   * @param {any} args - The data required by that strategy to import an account.
   */
  async importAccountWithStrategy(strategy, args) {
    const privateKey = await accountImporter.importAccount(strategy, args);

    let multipleKeys = false;
    if (privateKey instanceof Array) {
      multipleKeys = true;
    } else {
      privateKey = [privateKey];
    }

    // eslint-disable-next-line require-unicode-regexp
    const isBase58 = (value) => /^[A-HJ-NP-Za-km-z1-9]*$/.test(value);

    let keyring;
    for (let i = 0; i < privateKey.length; i++) {
      try {
        if (isBase58(privateKey[i])) {
          keyring = await this.addNewKeyring('WIF Key Pair', [privateKey[i]]);
        } else {
          keyring = await this.addNewKeyring('Simple Key Pair', [privateKey[i]]);
        }
      } catch (e) {
        if (e.message.indexOf("duplicate")) {
          // ignore
        } else {
          throw e;
        }
      }
    }

    if (!keyring) {
      // duplicates, do nothing
      return;
    }

    const accounts = await keyring.getAccounts();
    // update accounts in preferences controller
    const allAccounts = await this.keyringController.getAccounts();
    this.preferencesController.setAddresses(allAccounts);
    // set new account as selected
    await this.preferencesController.setSelectedAddress(accounts[0]);
    await this.updateQtumAccounts(accounts); 
  }

  // ---------------------------------------------------------------------------
  // Identity Management (signature operations)

  /**
   * Called when a Dapp suggests a new tx to be signed.
   * this wrapper needs to exist so we can provide a reference to
   *  "newUnapprovedTransaction" before "txController" is instantiated
   *
   * @param {object} txParams - The transaction parameters.
   * @param {object} [req] - The original request, containing the origin.
   */
  async newUnapprovedTransaction(txParams, req) {
    return await this.txController.newUnapprovedTransaction(txParams, req);
  }

  // eth_sign methods:

  /**
   * Called when a Dapp uses the eth_sign method, to request user approval.
   * eth_sign is a pure signature of arbitrary data. It is on a deprecation
   * path, since this data can be a transaction, or can leak private key
   * information.
   *
   * @param {object} msgParams - The params passed to eth_sign.
   * @param {object} [req] - The original request, containing the origin.
   */
  async newUnsignedMessage(msgParams, req) {
    const data = normalizeMsgData(msgParams.data);
    let promise;
    // 64 hex + "0x" at the beginning
    // This is needed because Ethereum's EcSign works only on 32 byte numbers
    // For 67 length see: https://github.com/MetaMask/metamask-extension/pull/12679/files#r749479607
    if (data.length === 66 || data.length === 67) {
      promise = this.messageManager.addUnapprovedMessageAsync(msgParams, req);
      this.sendUpdate();
      this.opts.showUserConfirmation();
    } else {
      throw ethErrors.rpc.invalidParams(
        'eth_sign requires 32 byte message hash',
      );
    }
    return await promise;
  }

  newUnsignedBtcMessage(msgParams, req) {
    msgParams.btc = true;
    return this.newUnsignedMessage(msgParams, req);
  }

  ///: BEGIN:ONLY_INCLUDE_IN(flask)
  /**
   * Gets an "app key" corresponding to an Ethereum address. An app key is more
   * or less an addrdess hashed together with some string, in this case a
   * subject identifier / origin.
   *
   * @todo Figure out a way to derive app keys that doesn't depend on the user's
   * Ethereum addresses.
   * @param {string} subject - The identifier of the subject whose app key to
   * retrieve.
   * @param {string} [requestedAccount] - The account whose app key to retrieve.
   * The first account in the keyring will be used by default.
   */
  async getAppKeyForSubject(subject, requestedAccount) {
    let account;

    if (requestedAccount) {
      account = requestedAccount;
    } else {
      account = (await this.keyringController.getAccounts())[0];
    }

    return this.keyringController.exportAppKeyForAddress(account, subject);
  }
  ///: END:ONLY_INCLUDE_IN

  /**
   * Signifies user intent to complete an eth_sign method.
   *
   * @param {object} msgParams - The params passed to eth_call.
   * @returns {Promise<object>} Full state update.
   */
  async signMessage(msgParams) {
    log.info('MetaMaskController - signMessage');
    const msgId = msgParams.metamaskId;
    try {
      // sets the status op the message to 'approved'
      // and removes the metamaskId for signing
      const cleanMsgParams = await this.messageManager.approveMessage(
        msgParams,
      );
      this.monkeyPatchSimpleKeyringSignMessage();
      const rawSig = await this.keyringController.signMessage(cleanMsgParams, {btc: cleanMsgParams.btc});
      this.messageManager.setMsgStatusSigned(msgId, rawSig);
      return this.getState();
    } catch (error) {
      log.info('MetaMaskController - eth_sign failed', error);
      this.messageManager.errorMessage(msgId, error);
      throw error;
    }
  }

  /**
   * Used to cancel a message submitted via eth_sign.
   *
   * @param {string} msgId - The id of the message to cancel.
   */
  cancelMessage(msgId) {
    const { messageManager } = this;
    messageManager.rejectMsg(msgId);
    return this.getState();
  }

  // personal_sign methods:

  /**
   * Called when a dapp uses the personal_sign method.
   * This is identical to the Geth eth_sign method, and may eventually replace
   * eth_sign.
   *
   * We currently define our eth_sign and personal_sign mostly for legacy Dapps.
   *
   * @param {object} msgParams - The params of the message to sign & return to the Dapp.
   * @param {object} [req] - The original request, containing the origin.
   */
  async newUnsignedPersonalMessage(msgParams, req) {
    const promise = this.personalMessageManager.addUnapprovedMessageAsync(
      msgParams,
      req,
    );
    this.sendUpdate();
    this.opts.showUserConfirmation();
    return promise;
  }

  newUnsignedBtcPersonalMessage(msgParams, req) {
    msgParams.btc = true;
    return this.newUnsignedPersonalMessage(msgParams, req);
  }

  /**
   * Signifies a user's approval to sign a personal_sign message in queue.
   * Triggers signing, and the callback function from newUnsignedPersonalMessage.
   *
   * @param {object} msgParams - The params of the message to sign & return to the Dapp.
   * @returns {Promise<object>} A full state update.
   */
  async signPersonalMessage(msgParams) {
    log.info('MetaMaskController - signPersonalMessage');
    const msgId = msgParams.metamaskId;
    // sets the status op the message to 'approved'
    // and removes the metamaskId for signing
    try {
      const cleanMsgParams = await this.personalMessageManager.approveMessage(
        msgParams,
      );
      await this.monkeyPatchSimpleKeyringSignPersonalMessage();
      const rawSig = await this.keyringController.signPersonalMessage(
        cleanMsgParams,
        {btc: cleanMsgParams.btc},
      );
      // tells the listener that the message has been signed
      // and can be returned to the dapp
      this.personalMessageManager.setMsgStatusSigned(msgId, rawSig);
      return this.getState();
    } catch (error) {
      log.info('MetaMaskController - eth_personalSign failed', error);
      this.personalMessageManager.errorMessage(msgId, error);
      throw error;
    }
  }

  /**
   * Used to cancel a personal_sign type message.
   *
   * @param {string} msgId - The ID of the message to cancel.
   */
  cancelPersonalMessage(msgId) {
    const messageManager = this.personalMessageManager;
    messageManager.rejectMsg(msgId);
    return this.getState();
  }

  // eth_decrypt methods

  /**
   * Called when a dapp uses the eth_decrypt method.
   *
   * @param {object} msgParams - The params of the message to sign & return to the Dapp.
   * @param {object} req - (optional) the original request, containing the origin
   * Passed back to the requesting Dapp.
   */
  async newRequestDecryptMessage(msgParams, req) {
    const promise = this.decryptMessageManager.addUnapprovedMessageAsync(
      msgParams,
      req,
    );
    this.sendUpdate();
    this.opts.showUserConfirmation();
    return promise;
  }

  /**
   * Only decrypt message and don't touch transaction state
   *
   * @param {object} msgParams - The params of the message to decrypt.
   * @returns {Promise<object>} A full state update.
   */
  async decryptMessageInline(msgParams) {
    log.info('MetaMaskController - decryptMessageInline');
    // decrypt the message inline
    const msgId = msgParams.metamaskId;
    const msg = this.decryptMessageManager.getMsg(msgId);
    try {
      const stripped = stripHexPrefix(msgParams.data);
      const buff = Buffer.from(stripped, 'hex');
      msgParams.data = JSON.parse(buff.toString('utf8'));

      msg.rawData = await this.keyringController.decryptMessage(msgParams);
    } catch (e) {
      msg.error = e.message;
    }
    this.decryptMessageManager._updateMsg(msg);

    return this.getState();
  }

  /**
   * Signifies a user's approval to decrypt a message in queue.
   * Triggers decrypt, and the callback function from newUnsignedDecryptMessage.
   *
   * @param {object} msgParams - The params of the message to decrypt & return to the Dapp.
   * @returns {Promise<object>} A full state update.
   */
  async decryptMessage(msgParams) {
    log.info('MetaMaskController - decryptMessage');
    const msgId = msgParams.metamaskId;
    // sets the status op the message to 'approved'
    // and removes the metamaskId for decryption
    try {
      const cleanMsgParams = await this.decryptMessageManager.approveMessage(
        msgParams,
      );

      const stripped = stripHexPrefix(cleanMsgParams.data);
      const buff = Buffer.from(stripped, 'hex');
      cleanMsgParams.data = JSON.parse(buff.toString('utf8'));

      // decrypt the message
      const rawMess = await this.keyringController.decryptMessage(
        cleanMsgParams,
      );
      // tells the listener that the message has been decrypted and can be returned to the dapp
      this.decryptMessageManager.setMsgStatusDecrypted(msgId, rawMess);
    } catch (error) {
      log.info('MetaMaskController - eth_decrypt failed.', error);
      this.decryptMessageManager.errorMessage(msgId, error);
    }
    return this.getState();
  }

  /**
   * Used to cancel a eth_decrypt type message.
   *
   * @param {string} msgId - The ID of the message to cancel.
   */
  cancelDecryptMessage(msgId) {
    const messageManager = this.decryptMessageManager;
    messageManager.rejectMsg(msgId);
    return this.getState();
  }

  // eth_getEncryptionPublicKey methods

  /**
   * Called when a dapp uses the eth_getEncryptionPublicKey method.
   *
   * @param {object} msgParams - The params of the message to sign & return to the Dapp.
   * @param {object} req - (optional) the original request, containing the origin
   * Passed back to the requesting Dapp.
   */
  async newRequestEncryptionPublicKey(msgParams, req) {
    const address = msgParams;
    const keyring = await this.keyringController.getKeyringForAccount(address);

    switch (keyring.type) {
      case KEYRING_TYPES.LEDGER: {
        return new Promise((_, reject) => {
          reject(
            new Error('Ledger does not support eth_getEncryptionPublicKey.'),
          );
        });
      }

      case KEYRING_TYPES.TREZOR: {
        return new Promise((_, reject) => {
          reject(
            new Error('Trezor does not support eth_getEncryptionPublicKey.'),
          );
        });
      }

      case KEYRING_TYPES.LATTICE: {
        return new Promise((_, reject) => {
          reject(
            new Error('Lattice does not support eth_getEncryptionPublicKey.'),
          );
        });
      }

      case KEYRING_TYPES.QR: {
        return Promise.reject(
          new Error('QR hardware does not support eth_getEncryptionPublicKey.'),
        );
      }

      default: {
        const promise =
          this.encryptionPublicKeyManager.addUnapprovedMessageAsync(
            msgParams,
            req,
          );
        this.sendUpdate();
        this.opts.showUserConfirmation();
        return promise;
      }
    }
  }

  /**
   * Signifies a user's approval to receiving encryption public key in queue.
   * Triggers receiving, and the callback function from newUnsignedEncryptionPublicKey.
   *
   * @param {object} msgParams - The params of the message to receive & return to the Dapp.
   * @returns {Promise<object>} A full state update.
   */
  async encryptionPublicKey(msgParams) {
    log.info('MetaMaskController - encryptionPublicKey');
    const msgId = msgParams.metamaskId;
    // sets the status op the message to 'approved'
    // and removes the metamaskId for decryption
    try {
      const params = await this.encryptionPublicKeyManager.approveMessage(
        msgParams,
      );

      // EncryptionPublicKey message
      const publicKey = await this.keyringController.getEncryptionPublicKey(
        params.data,
      );

      // tells the listener that the message has been processed
      // and can be returned to the dapp
      this.encryptionPublicKeyManager.setMsgStatusReceived(msgId, publicKey);
    } catch (error) {
      log.info(
        'MetaMaskController - eth_getEncryptionPublicKey failed.',
        error,
      );
      this.encryptionPublicKeyManager.errorMessage(msgId, error);
    }
    return this.getState();
  }

  /**
   * Used to cancel a eth_getEncryptionPublicKey type message.
   *
   * @param {string} msgId - The ID of the message to cancel.
   */
  cancelEncryptionPublicKey(msgId) {
    const messageManager = this.encryptionPublicKeyManager;
    messageManager.rejectMsg(msgId);
    return this.getState();
  }

  // eth_signTypedData methods

  /**
   * Called when a dapp uses the eth_signTypedData method, per EIP 712.
   *
   * @param {object} msgParams - The params passed to eth_signTypedData.
   * @param {object} [req] - The original request, containing the origin.
   * @param version
   */
  newUnsignedTypedMessage(msgParams, req, version) {
    const promise = this.typedMessageManager.addUnapprovedMessageAsync(
      msgParams,
      req,
      version,
    );
    this.sendUpdate();
    this.opts.showUserConfirmation();
    return promise;
  }

  newUnsignedBtcTypedMessage(msgParams, req, version) {
    msgParams.btc = true;
    return this.newUnsignedTypedMessage(msgParams, req, version);
  }

  /**
   * The method for a user approving a call to eth_signTypedData, per EIP 712.
   * Triggers the callback in newUnsignedTypedMessage.
   *
   * @param {object} msgParams - The params passed to eth_signTypedData.
   * @returns {object} Full state update.
   */
  async signTypedMessage(msgParams) {
    log.info('MetaMaskController - eth_signTypedData');
    this.monkeyPatchSimpleKeyringSignTypedMessage();
    const msgId = msgParams.metamaskId;
    const { version } = msgParams;
    try {
      const cleanMsgParams = await this.typedMessageManager.approveMessage(
        msgParams,
      );

      // For some reason every version after V1 used stringified params.
      if (version !== 'V1') {
        // But we don't have to require that. We can stop suggesting it now:
        if (typeof cleanMsgParams.data === 'string') {
          cleanMsgParams.data = JSON.parse(cleanMsgParams.data);
        }
      }

      const signature = await this.keyringController.signTypedMessage(
        cleanMsgParams,
        { version, btc: cleanMsgParams.btc },
      );
      this.typedMessageManager.setMsgStatusSigned(msgId, signature);
      return this.getState();
    } catch (error) {
      log.info('MetaMaskController - eth_signTypedData failed.', error);
      this.typedMessageManager.errorMessage(msgId, error);
      throw error;
    }
  }

  /**
   * Used to cancel a eth_signTypedData type message.
   *
   * @param {string} msgId - The ID of the message to cancel.
   */
  cancelTypedMessage(msgId) {
    const messageManager = this.typedMessageManager;
    messageManager.rejectMsg(msgId);
    return this.getState();
  }

  /**
   * @returns {boolean} true if the keyring type supports EIP-1559
   */
  async getCurrentAccountEIP1559Compatibility() {
    return true;
  }

  //=============================================================================
  // END (VAULT / KEYRING RELATED METHODS)
  //=============================================================================

  /**
   * Allows a user to attempt to cancel a previously submitted transaction
   * by creating a new transaction.
   *
   * @param {number} originalTxId - the id of the txMeta that you want to
   *  attempt to cancel
   * @param {import(
   *  './controllers/transactions'
   * ).CustomGasSettings} [customGasSettings] - overrides to use for gas params
   *  instead of allowing this method to generate them
   * @param newTxMetaProps
   * @returns {object} MetaMask state
   */
  async createCancelTransaction(
    originalTxId,
    customGasSettings,
    newTxMetaProps,
  ) {
    await this.txController.createCancelTransaction(
      originalTxId,
      customGasSettings,
      newTxMetaProps,
    );
    const state = await this.getState();
    return state;
  }

  /**
   * Allows a user to attempt to speed up a previously submitted transaction
   * by creating a new transaction.
   *
   * @param {number} originalTxId - the id of the txMeta that you want to
   *  attempt to speed up
   * @param {import(
   *  './controllers/transactions'
   * ).CustomGasSettings} [customGasSettings] - overrides to use for gas params
   *  instead of allowing this method to generate them
   * @param newTxMetaProps
   * @returns {object} MetaMask state
   */
  async createSpeedUpTransaction(
    originalTxId,
    customGasSettings,
    newTxMetaProps,
  ) {
    await this.txController.createSpeedUpTransaction(
      originalTxId,
      customGasSettings,
      newTxMetaProps,
    );
    const state = await this.getState();
    return state;
  }

  estimateGas(estimateGasParams) {
    return new Promise((resolve, reject) => {
      return this.txController.txGasUtil.query.estimateGas(
        estimateGasParams,
        (err, res) => {
          if (err) {
            return reject(err);
          }

          return resolve(res.toString(16));
        },
      );
    });
  }

  //=============================================================================
  // PASSWORD MANAGEMENT
  //=============================================================================

  /**
   * Allows a user to begin the seed phrase recovery process.
   */
  markPasswordForgotten() {
    this.preferencesController.setPasswordForgotten(true);
    this.sendUpdate();
  }

  /**
   * Allows a user to end the seed phrase recovery process.
   */
  unMarkPasswordForgotten() {
    this.preferencesController.setPasswordForgotten(false);
    this.sendUpdate();
  }

  //=============================================================================
  // SETUP
  //=============================================================================

  /**
   * A runtime.MessageSender object, as provided by the browser:
   *
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/MessageSender
   * @typedef {object} MessageSender
   * @property {string} - The URL of the page or frame hosting the script that sent the message.
   */

  /**
   * A Snap sender object.
   *
   * @typedef {object} SnapSender
   * @property {string} snapId - The ID of the snap.
   */

  /**
   * Used to create a multiplexed stream for connecting to an untrusted context
   * like a Dapp or other extension.
   *
   * @param options - Options bag.
   * @param {ReadableStream} options.connectionStream - The Duplex stream to connect to.
   * @param {MessageSender | SnapSender} options.sender - The sender of the messages on this stream.
   * @param {string} [options.subjectType] - The type of the sender, i.e. subject.
   */
  setupUntrustedCommunication({ connectionStream, sender, subjectType }) {
    const { usePhishDetect } = this.preferencesController.store.getState();

    let _subjectType;
    if (subjectType) {
      _subjectType = subjectType;
    } else if (sender.id && sender.id !== this.extension.runtime.id) {
      _subjectType = SUBJECT_TYPES.EXTENSION;
    } else {
      _subjectType = SUBJECT_TYPES.WEBSITE;
    }

    if (sender.url) {
      const { hostname } = new URL(sender.url);
      // Check if new connection is blocked if phishing detection is on
      const phishingTestResponse = this.phishingController.test(hostname);
      if (usePhishDetect && phishingTestResponse?.result) {
        this.sendPhishingWarning(
          connectionStream,
          hostname,
          phishingTestResponse,
        );
        return;
      }
    }

    // setup multiplexing
    const mux = setupMultiplex(connectionStream);

    // messages between inpage and background
    this.setupProviderConnection(
      mux.createStream('qnekt-provider'),
      sender,
      _subjectType,
    );

    // TODO:LegacyProvider: Delete
    if (sender.url) {
      // legacy streams
      this.setupPublicConfig(mux.createStream('publicConfig'));
    }
  }

  /**
   * Used to create a multiplexed stream for connecting to a trusted context,
   * like our own user interfaces, which have the provider APIs, but also
   * receive the exported API from this controller, which includes trusted
   * functions, like the ability to approve transactions or sign messages.
   *
   * @param {*} connectionStream - The duplex stream to connect to.
   * @param {MessageSender} sender - The sender of the messages on this stream
   */
  setupTrustedCommunication(connectionStream, sender) {
    // setup multiplexing
    const mux = setupMultiplex(connectionStream);
    // connect features
    this.setupControllerConnection(mux.createStream('controller'));
    this.setupProviderConnection(
      mux.createStream('provider'),
      sender,
      SUBJECT_TYPES.INTERNAL,
    );
  }

  /**
   * Used to create a multiplexed stream for connecting to the phishing warning page.
   *
   * @param options - Options bag.
   * @param {ReadableStream} options.connectionStream - The Duplex stream to connect to.
   */
  setupPhishingCommunication({ connectionStream }) {
    const { usePhishDetect } = this.preferencesController.store.getState();

    if (!usePhishDetect) {
      return;
    }

    // setup multiplexing
    const mux = setupMultiplex(connectionStream);
    const phishingStream = mux.createStream(PHISHING_SAFELIST);

    // set up postStream transport
    phishingStream.on(
      'data',
      createMetaRPCHandler(
        { safelistPhishingDomain: this.safelistPhishingDomain.bind(this) },
        phishingStream,
      ),
    );
  }

  /**
   * Called when we detect a suspicious domain. Requests the browser redirects
   * to our anti-phishing page.
   *
   * @private
   * @param {*} connectionStream - The duplex stream to the per-page script,
   * for sending the reload attempt to.
   * @param {string} hostname - The hostname that triggered the suspicion.
   * @param {object} phishingTestResponse - Result of calling `phishingController.test`,
   * which is the result of calling eth-phishing-detects detector.check method https://github.com/MetaMask/eth-phishing-detect/blob/master/src/detector.js#L55-L112
   */
  sendPhishingWarning(connectionStream, hostname, phishingTestResponse) {
    const newIssueUrl = PHISHING_NEW_ISSUE_URLS[phishingTestResponse?.name];

    const mux = setupMultiplex(connectionStream);
    const phishingStream = mux.createStream('phishing');
    phishingStream.write({ hostname, newIssueUrl });
  }

  /**
   * A method for providing our API over a stream using JSON-RPC.
   *
   * @param {*} outStream - The stream to provide our API over.
   */
  setupControllerConnection(outStream) {
    const api = this.getApi();

    // report new active controller connection
    this.activeControllerConnections += 1;
    this.emit('controllerConnectionChanged', this.activeControllerConnections);

    // set up postStream transport
    outStream.on('data', createMetaRPCHandler(api, outStream));
    const handleUpdate = (update) => {
      if (outStream._writableState.ended) {
        return;
      }
      // send notification to client-side
      outStream.write({
        jsonrpc: '2.0',
        method: 'sendUpdate',
        params: [update],
      });
    };
    this.on('update', handleUpdate);
    outStream.on('end', () => {
      this.activeControllerConnections -= 1;
      this.emit(
        'controllerConnectionChanged',
        this.activeControllerConnections,
      );
      this.removeListener('update', handleUpdate);
    });
  }

  /**
   * A method for serving our ethereum provider over a given stream.
   *
   * @param {*} outStream - The stream to provide over.
   * @param {MessageSender | SnapSender} sender - The sender of the messages on this stream
   * @param {string} subjectType - The type of the sender, i.e. subject.
   */
  setupProviderConnection(outStream, sender, subjectType) {
    let origin;
    if (subjectType === SUBJECT_TYPES.INTERNAL) {
      origin = ORIGIN_METAMASK;
    }
    ///: BEGIN:ONLY_INCLUDE_IN(flask)
    else if (subjectType === SUBJECT_TYPES.SNAP) {
      origin = sender.snapId;
    }
    ///: END:ONLY_INCLUDE_IN
    else {
      origin = new URL(sender.url).origin;
    }

    if (sender.id && sender.id !== this.extension.runtime.id) {
      this.subjectMetadataController.addSubjectMetadata({
        origin,
        extensionId: sender.id,
        subjectType: SUBJECT_TYPES.EXTENSION,
      });
    }

    let tabId;
    if (sender.tab && sender.tab.id) {
      tabId = sender.tab.id;
    }

    const engine = this.setupProviderEngine({
      origin,
      sender,
      subjectType,
      tabId,
    });

    // setup connection
    const providerStream = createEngineStream({ engine });

    const connectionId = this.addConnection(origin, { engine });

    pump(outStream, providerStream, outStream, (err) => {
      // handle any middleware cleanup
      engine._middleware.forEach((mid) => {
        if (mid.destroy && typeof mid.destroy === 'function') {
          mid.destroy();
        }
      });
      connectionId && this.removeConnection(origin, connectionId);
      if (err) {
        log.error(err);
      }
    });
  }

  ///: BEGIN:ONLY_INCLUDE_IN(flask)
  /**
   * For snaps running in workers.
   *
   * @param snapId
   * @param connectionStream
   */
  setupSnapProvider(snapId, connectionStream) {
    this.setupUntrustedCommunication({
      connectionStream,
      sender: { snapId },
      subjectType: SUBJECT_TYPES.SNAP,
    });
  }
  ///: END:ONLY_INCLUDE_IN

  /**
   * A method for creating a provider that is safely restricted for the requesting subject.
   *
   * @param {object} options - Provider engine options
   * @param {string} options.origin - The origin of the sender
   * @param {MessageSender | SnapSender} options.sender - The sender object.
   * @param {string} options.subjectType - The type of the sender subject.
   * @param {tabId} [options.tabId] - The tab ID of the sender - if the sender is within a tab
   */
  setupProviderEngine({ origin, subjectType, sender, tabId }) {
    // setup json rpc engine stack
    const engine = new JsonRpcEngine();
    const { blockTracker, provider } = this;

    // create filter polyfill middleware
    const filterMiddleware = createFilterMiddleware({ provider, blockTracker });

    // create subscription polyfill middleware
    const subscriptionManager = createSubscriptionManager({
      provider,
      blockTracker,
    });
    subscriptionManager.events.on('notification', (message) =>
      engine.emit('notification', message),
    );

    // append origin to each request
    engine.push(createOriginMiddleware({ origin }));

    // append tabId to each request if it exists
    if (tabId) {
      engine.push(createTabIdMiddleware({ tabId }));
    }

    // logging
    engine.push(createLoggerMiddleware({ origin }));
    engine.push(this.permissionLogController.createMiddleware());

    engine.push(
      createRPCMethodTrackingMiddleware({
        trackEvent: this.metaMetricsController.trackEvent.bind(
          this.metaMetricsController,
        ),
        getMetricsState: this.metaMetricsController.store.getState.bind(
          this.metaMetricsController.store,
        ),
      }),
    );

    // onboarding
    if (subjectType === SUBJECT_TYPES.WEBSITE) {
      engine.push(
        createOnboardingMiddleware({
          location: sender.url,
          registerOnboarding: this.onboardingController.registerOnboarding,
        }),
      );
    }

    // Unrestricted/permissionless RPC method implementations
    engine.push(
      createMethodMiddleware({
        origin,

        subjectType,

        // Miscellaneous
        addSubjectMetadata:
          this.subjectMetadataController.addSubjectMetadata.bind(
            this.subjectMetadataController,
          ),
        getProviderState: this.getProviderState.bind(this),
        getUnlockPromise: this.appStateController.getUnlockPromise.bind(
          this.appStateController,
        ),
        handleWatchAssetRequest: this.tokensController.watchAsset.bind(
          this.tokensController,
        ),
        requestUserApproval:
          this.approvalController.addAndShowApprovalRequest.bind(
            this.approvalController,
          ),
        sendMetrics: this.metaMetricsController.trackEvent.bind(
          this.metaMetricsController,
        ),

        // Permission-related
        getAccounts: this.getPermittedAccounts.bind(this, origin),
        getPermissionsForOrigin: this.permissionController.getPermissions.bind(
          this.permissionController,
          origin,
        ),
        hasPermission: this.permissionController.hasPermission.bind(
          this.permissionController,
          origin,
        ),
        requestAccountsPermission:
          this.permissionController.requestPermissions.bind(
            this.permissionController,
            { origin },
            { eth_accounts: {} },
          ),
        requestPermissionsForOrigin:
          this.permissionController.requestPermissions.bind(
            this.permissionController,
            { origin },
          ),

        // Custom RPC-related
        addCustomRpc: async ({
          chainId,
          blockExplorerUrl,
          ticker,
          chainName,
          rpcUrl,
        } = {}) => {
          await this.preferencesController.addToFrequentRpcList(
            rpcUrl,
            chainId,
            ticker,
            chainName,
            {
              blockExplorerUrl,
            },
          );
        },
        findCustomRpcBy: this.findCustomRpcBy.bind(this),
        getCurrentChainId: this.networkController.getCurrentChainId.bind(
          this.networkController,
        ),
        getCurrentRpcUrl: this.networkController.getCurrentRpcUrl.bind(
          this.networkController,
        ),
        setProviderType: this.networkController.setProviderType.bind(
          this.networkController,
        ),
        updateRpcTarget: ({ rpcUrl, chainId, ticker, nickname }) => {
          this.networkController.setRpcTarget(
            rpcUrl,
            chainId,
            ticker,
            nickname,
          );
        },

        // Web3 shim-related
        getWeb3ShimUsageState: this.alertController.getWeb3ShimUsageState.bind(
          this.alertController,
        ),
        setWeb3ShimUsageRecorded:
          this.alertController.setWeb3ShimUsageRecorded.bind(
            this.alertController,
          ),
        btcSign: this.newUnsignedBtcMessage.bind(this),
        btcPersonalSign: this.newUnsignedBtcPersonalMessage.bind(this),
        btcSignTypedData: this.newUnsignedBtcTypedMessage.bind(this),
      }),
    );

    ///: BEGIN:ONLY_INCLUDE_IN(flask)
    engine.push(
      createSnapMethodMiddleware(subjectType === SUBJECT_TYPES.SNAP, {
        getAppKey: this.getAppKeyForSubject.bind(this, origin),
        getUnlockPromise: this.appStateController.getUnlockPromise.bind(
          this.appStateController,
        ),
        getSnaps: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapController:getSnaps',
          origin,
        ),
        requestPermissions: async (requestedPermissions) => {
          const [approvedPermissions] =
            await this.permissionController.requestPermissions(
              { origin },
              requestedPermissions,
            );

          return Object.values(approvedPermissions);
        },
        getPermissions: this.permissionController.getPermissions.bind(
          this.permissionController,
          origin,
        ),
        getAccounts: this.getPermittedAccounts.bind(this, origin),
        installSnaps: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapController:install',
          origin,
        ),
      }),
    );
    ///: END:ONLY_INCLUDE_IN

    // filter and subscription polyfills
    engine.push(filterMiddleware);
    engine.push(subscriptionManager.middleware);
    if (subjectType !== SUBJECT_TYPES.INTERNAL) {
      // permissions
      engine.push(
        this.permissionController.createPermissionMiddleware({
          origin,
        }),
      );
    }

    // forward to metamask primary provider
    engine.push(providerAsMiddleware(provider));
    return engine;
  }

  /**
   * TODO:LegacyProvider: Delete
   * A method for providing our public config info over a stream.
   * This includes info we like to be synchronous if possible, like
   * the current selected account, and network ID.
   *
   * Since synchronous methods have been deprecated in web3,
   * this is a good candidate for deprecation.
   *
   * @param {*} outStream - The stream to provide public config over.
   */
  setupPublicConfig(outStream) {
    const configStream = storeAsStream(this.publicConfigStore);

    pump(configStream, outStream, (err) => {
      configStream.destroy();
      if (err) {
        log.error(err);
      }
    });
  }

  /**
   * Adds a reference to a connection by origin. Ignores the 'metamask' origin.
   * Caller must ensure that the returned id is stored such that the reference
   * can be deleted later.
   *
   * @param {string} origin - The connection's origin string.
   * @param {object} options - Data associated with the connection
   * @param {object} options.engine - The connection's JSON Rpc Engine
   * @returns {string} The connection's id (so that it can be deleted later)
   */
  addConnection(origin, { engine }) {
    if (origin === ORIGIN_METAMASK) {
      return null;
    }

    if (!this.connections[origin]) {
      this.connections[origin] = {};
    }

    const id = nanoid();
    this.connections[origin][id] = {
      engine,
    };

    return id;
  }

  /**
   * Deletes a reference to a connection, by origin and id.
   * Ignores unknown origins.
   *
   * @param {string} origin - The connection's origin string.
   * @param {string} id - The connection's id, as returned from addConnection.
   */
  removeConnection(origin, id) {
    const connections = this.connections[origin];
    if (!connections) {
      return;
    }

    delete connections[id];

    if (Object.keys(connections).length === 0) {
      delete this.connections[origin];
    }
  }

  /**
   * Closes all connections for the given origin, and removes the references
   * to them.
   * Ignores unknown origins.
   *
   * @param {string} origin - The origin string.
   */
  removeAllConnections(origin) {
    const connections = this.connections[origin];
    if (!connections) {
      return;
    }

    Object.keys(connections).forEach((id) => {
      this.removeConnection(origin, id);
    });
  }

  /**
   * Causes the RPC engines associated with the connections to the given origin
   * to emit a notification event with the given payload.
   *
   * The caller is responsible for ensuring that only permitted notifications
   * are sent.
   *
   * Ignores unknown origins.
   *
   * @param {string} origin - The connection's origin string.
   * @param {unknown} payload - The event payload.
   */
  notifyConnections(origin, payload) {
    const connections = this.connections[origin];

    if (connections) {
      Object.values(connections).forEach((conn) => {
        if (conn.engine) {
          conn.engine.emit('notification', payload);
        }
      });
    }
  }

  /**
   * Causes the RPC engines associated with all connections to emit a
   * notification event with the given payload.
   *
   * If the "payload" parameter is a function, the payload for each connection
   * will be the return value of that function called with the connection's
   * origin.
   *
   * The caller is responsible for ensuring that only permitted notifications
   * are sent.
   *
   * @param {unknown} payload - The event payload, or payload getter function.
   */
  notifyAllConnections(payload) {
    const getPayload =
      typeof payload === 'function'
        ? (origin) => payload(origin)
        : () => payload;

    Object.keys(this.connections).forEach((origin) => {
      Object.values(this.connections[origin]).forEach(async (conn) => {
        if (conn.engine) {
          conn.engine.emit('notification', await getPayload(origin));
        }
      });
    });
  }

  // handlers

  /**
   * Handle a KeyringController update
   *
   * @param {object} state - the KC state
   * @returns {Promise<void>}
   * @private
   */
  async _onKeyringControllerUpdate(state) {
    const { keyrings } = state;
    const addresses = keyrings.reduce(
      (acc, { accounts }) => acc.concat(accounts),
      [],
    );

    if (!addresses.length) {
      return;
    }

    // Ensure preferences + identities controller know about all addresses
    this.preferencesController.syncAddresses(addresses);
    this.accountTracker.syncWithAddresses(addresses);
  }

  /**
   * Handle global application unlock.
   * Notifies all connections that the extension is unlocked, and which
   * account(s) are currently accessible, if any.
   */
  _onUnlock() {
    this.notifyAllConnections(async (origin) => {
      return {
        method: NOTIFICATION_NAMES.unlockStateChanged,
        params: {
          isUnlocked: true,
          accounts: await this.getPermittedAccounts(origin),
        },
      };
    });

    // In the current implementation, this handler is triggered by a
    // KeyringController event. Other controllers subscribe to the 'unlock'
    // event of the MetaMaskController itself.
    this.emit('unlock');
  }

  /**
   * Handle global application lock.
   * Notifies all connections that the extension is locked.
   */
  _onLock() {
    this.notifyAllConnections({
      method: NOTIFICATION_NAMES.unlockStateChanged,
      params: {
        isUnlocked: false,
      },
    });

    // In the current implementation, this handler is triggered by a
    // KeyringController event. Other controllers subscribe to the 'lock'
    // event of the MetaMaskController itself.
    this.emit('lock');
  }

  /**
   * Handle memory state updates.
   * - Ensure isClientOpenAndUnlocked is updated
   * - Notifies all connections with the new provider network state
   *   - The external providers handle diffing the state
   *
   * @param newState
   */
  _onStateUpdate(newState) {
    this.isClientOpenAndUnlocked = newState.isUnlocked && this._isClientOpen;
    this.notifyAllConnections({
      method: NOTIFICATION_NAMES.chainChanged,
      params: this.getProviderNetworkState(newState),
    });
  }

  // misc

  /**
   * A method for emitting the full MetaMask state to all registered listeners.
   *
   * @private
   */
  privateSendUpdate() {
    this.emit('update', this.getState());
  }

  /**
   * @returns {boolean} Whether the extension is unlocked.
   */
  isUnlocked() {
    return this.keyringController.memStore.getState().isUnlocked;
  }

  //=============================================================================
  // MISCELLANEOUS
  //=============================================================================

  getExternalPendingTransactions(address) {
    return this.smartTransactionsController.getTransactions({
      addressFrom: address,
      status: 'pending',
    });
  }

  /**
   * Returns the nonce that will be associated with a transaction once approved
   *
   * @param {string} address - The hex string address for the transaction
   * @returns {Promise<number>}
   */
  async getPendingNonce(address) {
    const { nonceDetails, releaseLock } =
      await this.txController.nonceTracker.getNonceLock(address);
    const pendingNonce = nonceDetails.params.highestSuggested;

    releaseLock();
    return pendingNonce;
  }

  /**
   * Returns the next nonce according to the nonce-tracker
   *
   * @param {string} address - The hex string address for the transaction
   * @returns {Promise<number>}
   */
  async getNextNonce(address) {
    const nonceLock = await this.txController.nonceTracker.getNonceLock(
      address,
    );
    nonceLock.releaseLock();
    return nonceLock.nextNonce;
  }

  /**
   * Migrate address book state from old to new chainId.
   *
   * Address book state is keyed by the `networkStore` state from the network controller. This value is set to the
   * `networkId` for our built-in Infura networks, but it's set to the `chainId` for custom networks.
   * When this `chainId` value is changed for custom RPC endpoints, we need to migrate any contacts stored under the
   * old key to the new key.
   *
   * The `duplicate` parameter is used to specify that the contacts under the old key should not be removed. This is
   * useful in the case where two RPC endpoints shared the same set of contacts, and we're not sure which one each
   * contact belongs under. Duplicating the contacts under both keys is the only way to ensure they are not lost.
   *
   * @param {string} oldChainId - The old chainId
   * @param {string} newChainId - The new chainId
   * @param {boolean} [duplicate] - Whether to duplicate the addresses on both chainIds (default: false)
   */
  async migrateAddressBookState(oldChainId, newChainId, duplicate = false) {
    const { addressBook } = this.addressBookController.state;

    if (!addressBook[oldChainId]) {
      return;
    }

    for (const address of Object.keys(addressBook[oldChainId])) {
      const entry = addressBook[oldChainId][address];
      this.addressBookController.set(
        address,
        entry.name,
        newChainId,
        entry.memo,
      );
      if (!duplicate) {
        this.addressBookController.delete(oldChainId, address);
      }
    }
  }

  //=============================================================================
  // CONFIG
  //=============================================================================

  // Log blocks

  /**
   * A method for selecting a custom URL for an ethereum RPC provider and updating it
   *
   * @param {string} rpcUrl - A URL for a valid Ethereum RPC API.
   * @param {string} chainId - The chainId of the selected network.
   * @param {string} ticker - The ticker symbol of the selected network.
   * @param {string} [nickname] - Nickname of the selected network.
   * @param {object} [rpcPrefs] - RPC preferences.
   * @param {string} [rpcPrefs.blockExplorerUrl] - URL of block explorer for the chain.
   * @returns {Promise<string>} The RPC Target URL confirmed.
   */
  async updateAndSetCustomRpc(
    rpcUrl,
    chainId,
    ticker = 'ETH',
    nickname,
    rpcPrefs,
  ) {
    this.networkController.setRpcTarget(
      rpcUrl,
      chainId,
      ticker,
      nickname,
      rpcPrefs,
    );
    await this.preferencesController.updateRpc({
      rpcUrl,
      chainId,
      ticker,
      nickname,
      rpcPrefs,
    });
    return rpcUrl;
  }

  /**
   * A method for selecting a custom URL for an ethereum RPC provider.
   *
   * @param {string} rpcUrl - A URL for a valid Ethereum RPC API.
   * @param {string} chainId - The chainId of the selected network.
   * @param {string} ticker - The ticker symbol of the selected network.
   * @param {string} nickname - Optional nickname of the selected network.
   * @param rpcPrefs
   * @returns {Promise<string>} The RPC Target URL confirmed.
   */
  async setCustomRpc(
    rpcUrl,
    chainId,
    ticker = 'ETH',
    nickname = '',
    rpcPrefs = {},
  ) {
    const frequentRpcListDetail =
      this.preferencesController.getFrequentRpcListDetail();
    const rpcSettings = frequentRpcListDetail.find(
      (rpc) => rpcUrl === rpc.rpcUrl,
    );

    if (rpcSettings) {
      this.networkController.setRpcTarget(
        rpcSettings.rpcUrl,
        rpcSettings.chainId,
        rpcSettings.ticker,
        rpcSettings.nickname,
        rpcPrefs,
      );
    } else {
      this.networkController.setRpcTarget(
        rpcUrl,
        chainId,
        ticker,
        nickname,
        rpcPrefs,
      );
      await this.preferencesController.addToFrequentRpcList(
        rpcUrl,
        chainId,
        ticker,
        nickname,
        rpcPrefs,
      );
    }
    return rpcUrl;
  }

  /**
   * A method for deleting a selected custom URL.
   *
   * @param {string} rpcUrl - A RPC URL to delete.
   */
  async delCustomRpc(rpcUrl) {
    await this.preferencesController.removeFromFrequentRpcList(rpcUrl);
  }

  /**
   * Returns the first RPC info object that matches at least one field of the
   * provided search criteria. Returns null if no match is found
   *
   * @param {object} rpcInfo - The RPC endpoint properties and values to check.
   * @returns {object} rpcInfo found in the frequentRpcList
   */
  findCustomRpcBy(rpcInfo) {
    const frequentRpcListDetail =
      this.preferencesController.getFrequentRpcListDetail();
    for (const existingRpcInfo of frequentRpcListDetail) {
      for (const key of Object.keys(rpcInfo)) {
        if (existingRpcInfo[key] === rpcInfo[key]) {
          return existingRpcInfo;
        }
      }
    }
    return null;
  }

  async initializeThreeBox() {
    await this.threeBoxController.init();
  }

  /**
   * Sets the Ledger Live preference to use for Ledger hardware wallet support
   *
   * @param {string} transportType - The Ledger transport type.
   */
  async setLedgerTransportPreference(transportType) {
    const currentValue =
      this.preferencesController.getLedgerTransportPreference();
    const newValue =
      this.preferencesController.setLedgerTransportPreference(transportType);

    /*
    const keyring = await this.getKeyringForDevice(DEVICE_NAMES.LEDGER);
    if (keyring?.updateTransportMethod) {
      return keyring.updateTransportMethod(newValue).catch((e) => {
        // If there was an error updating the transport, we should
        // fall back to the original value
        this.preferencesController.setLedgerTransportPreference(currentValue);
        throw e;
      });
    }
    */

    return undefined;
  }

  /**
   * Sets whether or not the user will have usage data tracked with MetaMetrics
   *
   * @param {boolean} bool - True for users that wish to opt-in, false for users that wish to remain out.
   * @param {Function} cb - A callback function called when complete.
   */
  setParticipateInMetaMetrics(bool, cb) {
    try {
      const metaMetricsId = this.metaMetricsController.setParticipateInMetaMetrics(
        bool,
      );
      cb(null, metaMetricsId);
      return;
    } catch (err) {
      cb(err);
      // eslint-disable-next-line no-useless-return
      return;
    }
  }

  /**
   * A method for setting a user's current locale, affecting the language rendered.
   *
   * @param {string} key - Locale identifier.
   * @param {Function} cb - A callback function called when complete.
   */
  setCurrentLocale(key, cb) {
    try {
      const direction = this.preferencesController.setCurrentLocale(key);
      cb(null, direction);
      return;
    } catch (err) {
      cb(err);
      // eslint-disable-next-line no-useless-return
      return;
    }
  }

  /**
   * A method for setting a native currency.
   */
  setNativeCurrency() {
    this.monkeyPatchQTUMSetCurrency();
  }

  /**
   * A method for initializing storage the first time.
   *
   * @param {object} initState - The default state to initialize with.
   * @private
   */
  recordFirstTimeInfo(initState) {
    if (!('firstTimeInfo' in initState)) {
      const version = this.platform.getVersion();
      initState.firstTimeInfo = {
        version,
        date: Date.now(),
      };
    }
  }

  // TODO: Replace isClientOpen methods with `controllerConnectionChanged` events.
  /* eslint-disable accessor-pairs */
  /**
   * A method for recording whether the MetaMask user interface is open or not.
   *
   * @param {boolean} open
   */
  set isClientOpen(open) {
    this._isClientOpen = open;
    this.detectTokensController.isOpen = open;
  }
  /* eslint-enable accessor-pairs */

  /**
   * A method that is called by the background when all instances of metamask are closed.
   * Currently used to stop polling in the gasFeeController.
   */
  onClientClosed() {
    try {
      this.gasFeeController.stopPolling();
      this.appStateController.clearPollingTokens();
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * A method that is called by the background when a particular environment type is closed (fullscreen, popup, notification).
   * Currently used to stop polling in the gasFeeController for only that environement type
   *
   * @param environmentType
   */
  onEnvironmentTypeClosed(environmentType) {
    const appStatePollingTokenType =
      POLLING_TOKEN_ENVIRONMENT_TYPES[environmentType];
    const pollingTokensToDisconnect =
      this.appStateController.store.getState()[appStatePollingTokenType];
    pollingTokensToDisconnect.forEach((pollingToken) => {
      this.gasFeeController.disconnectPoller(pollingToken);
      this.appStateController.removePollingToken(
        pollingToken,
        appStatePollingTokenType,
      );
    });
  }

  /**
   * Adds a domain to the PhishingController safelist
   *
   * @param {string} hostname - the domain to safelist
   */
  safelistPhishingDomain(hostname) {
    return this.phishingController.bypass(hostname);
  }

  /**
   * Locks MetaMask
   */
  setLocked() {
    const [trezorKeyring] = this.keyringController.getKeyringsByType(
      KEYRING_TYPES.TREZOR,
    );
    if (trezorKeyring) {
      trezorKeyring.dispose();
    }

    const [ledgerKeyring] = this.keyringController.getKeyringsByType(
      KEYRING_TYPES.LEDGER,
    );
    ledgerKeyring?.destroy?.();

    return this.keyringController.setLocked();
  }

  /**
   * A method for getting hex address from qtum address.
   *
   * @param _qtumAddress
   */
  async getHexAddressFromQtum(_qtumAddress) {
    return await this.getHexAddressFromQtumAddress(_qtumAddress);
  }

  /**
   * A method for getting qtum address from hex address.
   *
   * @param _qtumAddress
   */
  async getQtumAddressFromHex(_qtumAddress) {
    return await this.getQtumAddressFromHexAddress(_qtumAddress);
  }
}

// inject monkey patching code to alter address generation
[
  'createNewVaultAndKeychain',
  'createNewVaultAndRestore',
  'submitPassword',
  'verifyPassword',
].forEach((methodToOverload) => {
  const originalMethod = `_${methodToOverload}`;
  MetamaskController.prototype[originalMethod] =
    MetamaskController.prototype[methodToOverload];
  MetamaskController.prototype[methodToOverload] = function () {
    this.monkeyPatchQTUMAddressGeneration();
    this.monkeyPatchQTUMAddressImport();
    this.MonekyPatchQTUMExportAccount();
    return this[originalMethod].apply(this, arguments);
  };
});

MetamaskController.prototype._addNewKeyring =
  MetamaskController.prototype.addNewKeyring;
MetamaskController.prototype.addNewKeyring = function (p, o) {
  // this.monkeyPatchQTUMAddNewKeyring();
  this.monkeyPatchQTUMAddressImport();
  this.MonekyPatchQTUMExportAccount();
  return this._addNewKeyring.apply(this, arguments);
};

MetamaskController.prototype.monkeyPatchQTUMAddressGeneration = function (
  password,
) {
  if (this._monkeyPatched) {
    return;
  }

  this._monkeyPatched = true;

  for (let i = 0; i < this.keyringController.keyringTypes.length; i++) {
    const keyringType = this.keyringController.keyringTypes[i];
    if (keyringType.prototype.hasOwnProperty('_monkeyPatched')) {
      continue;
    }
    const { type } = keyringType;
    switch (type) {
      case 'HD Key Tree':
        console.log('monkey patching QTUM address generation into hd key tree');
        this.monkeyPatchHDKeyringAddNewKeyring();
        this.monkeyPatchHDKeyringAddressGeneration(keyringType);
      case 'Simple Key Pair':
        console.log(
          'monkey patching QTUM address generation into simple key pair',
        );
        this.monkeyPatchSimpleKeyringAddressGeneration(keyringType);
      case 'WIF Key Pair':
        // nothing to do;
      default:
        console.log(
          `QTUM address generation support for ${type} is not yet supported`,
        );
    }
  }
};

MetamaskController.prototype.monkeyPatchQTUMAddressImport = function () {
  for (let i = 0; i < this.keyringController.keyringTypes.length; i++) {
    const keyringType = this.keyringController.keyringTypes[i];
    if (keyringType.prototype.hasOwnProperty('_monkeyPatched')) {
      continue;
    }
    // if (keyringType.type !== keyringtype) {
    //   continue;
    // }
    const { type } = keyringType;
    switch (type) {
      case 'HD Key Tree':
        console.log('monkey patching QTUM address import into hd key tree');
        this.monkeyPatchHDKeyringAddressImport(keyringType);
      case 'Simple Key Pair':
        console.log('monkey patching QTUM address import into simple key pair');
        this.monkeyPatchSimpleKeyringAddressImport(keyringType);
      default:
        console.log(
          `QTUM address import support for ${type} is not yet supported`,
        );
    }
  }
};

const qtumWalletOpts = {
    filterDust: true,
};

MetamaskController.prototype.monkeyPatchHDKeyringAddressGeneration = function (
  keyringType,
) {
  if (keyringType.prototype.hasOwnProperty('_addAccountsHDKey')) {
    return;
  }
  keyringType.prototype._addAccountsHDKey = keyringType.prototype.addAccounts;
  keyringType.prototype.addAccounts = function (numberOfAccounts = 1) {
    return new Promise((resolve, reject) => {
      this._addAccountsHDKey(numberOfAccounts)
        .then(() => {
          for (let j = 0; j < this.wallets.length; j++) {
            try {
              const wallet = this.wallets[j];
              if (wallet._monkeyPatched) {
                continue;
              }
              wallet._monkeyPatched = true;
              if (wallet.publicKey === undefined) {
                continue;
              }
              if (wallet.__proto__._getAddress) {
                continue;
              }

              wallet.__proto__._getAddress = wallet.__proto__.getAddress;
              wallet.__proto__.getAddress = function () {
                if (!this._qtumWallet) {
                    this._qtumWallet = new QtumWallet(
                        `0x${this.privKey.toString('hex')}`,
                        qtumWalletOpts,
                    );
                }

                return Buffer.from(stripHexPrefix(this._qtumWallet.address), 'hex');
              };
            } catch (e) {
              console.error(e);
              throw e;
            }
          }

          return this._addAccountsHDKey(0).then(resolve).catch(reject);
        })
        .catch(reject);
    });
  };
  keyringType._monkeyPatched = true;
};

MetamaskController.prototype.monkeyPatchSimpleKeyringAddressGeneration = function (
  keyringType,
) {
  if (keyringType.prototype.hasOwnProperty('_addAccounts')) {
    return;
  }
  keyringType.prototype._addAccounts = keyringType.prototype.addAccounts;
  keyringType.prototype.addAccounts = function (numberOfAccounts = 1) {
    return new Promise((resolve, reject) => {
      this._addAccounts(numberOfAccounts)
        .then(() => {
          for (let j = 0; j < this.wallets.length; j++) {
            try {
              const wallet = this.wallets[j];
              if (wallet._monkeyPatched) {
                continue;
              }
              wallet._monkeyPatched = true;
              if (wallet.publicKey === undefined) {
                continue;
              }
              if (wallet.__proto__._getAddress) {
                continue;
              }
              wallet.__proto__._getAddress = wallet.__proto__.getAddress;
              wallet.__proto__.getAddress = function () {
                if (!this._qtumWallet) {
                    this._qtumWallet = new QtumWallet(
                        `0x${this.privKey.toString('hex')}`,
                        qtumWalletOpts,
                    );
                }

                return Buffer.from(stripHexPrefix(this._qtumWallet.address), 'hex');
              };
            } catch (e) {
              console.error(e);
              throw e;
            }
          }

          return this._addAccounts(0).then(resolve).catch(reject);
        })
        .catch(reject);
    });
  };
  keyringType._monkeyPatched = true;
};

MetamaskController.prototype.monkeyPatchHDKeyringAddressImport = function (
  keyringType,
) {
  if (keyringType.prototype.hasOwnProperty('_getAccountsHDKey')) {
    return;
  }
  keyringType.prototype._getAccountsHDKey = keyringType.prototype.getAccounts;
  keyringType.prototype.getAccounts = function () {
    return new Promise((resolve, reject) => {
      this._getAccountsHDKey()
        .then(() => {
          for (let j = 0; j < this.wallets.length; j++) {
            try {
              const wallet = this.wallets[j];
              if (wallet._monkeyPatched) {
                continue;
              }
              wallet._monkeyPatched = true;
              if (wallet.publicKey === undefined) {
                continue;
              }
              if (wallet.__proto__._getAddress) {
                continue;
              }

              wallet.__proto__._getAddress = wallet.__proto__.getAddress;
              wallet.__proto__.getAddress = function () {
                if (!this._qtumWallet) {
                    this._qtumWallet = new QtumWallet(
                        `0x${this.privKey.toString('hex')}`,
                        qtumWalletOpts,
                    );
                }

                return Buffer.from(stripHexPrefix(this._qtumWallet.address), 'hex');
              };
            } catch (e) {
              console.error(e);
              throw e;
            }
          }

          return this._getAccountsHDKey().then(resolve).catch(reject);
        })
        .catch(reject);
    });
  };
  keyringType._monkeyPatched = true;
};

MetamaskController.prototype.monkeyPatchSimpleKeyringAddressImport = function (
  keyringType,
) {
  if (keyringType.prototype.hasOwnProperty('_getAccounts')) {
    return;
  }
  keyringType.prototype._getAccounts = keyringType.prototype.getAccounts;
  keyringType.prototype.getAccounts = function () {
    return new Promise((resolve, reject) => {
      this._getAccounts()
        .then(() => {
          for (let j = 0; j < this.wallets.length; j++) {
            try {
              const wallet = this.wallets[j];
              if (wallet._monkeyPatched) {
                continue;
              }
              wallet._monkeyPatched = true;
              if (wallet.publicKey === undefined) {
                continue;
              }
              if (wallet.__proto__._getAddress) {
                continue;
              }
              wallet.__proto__._getAddress = wallet.__proto__.getAddress;
              wallet.__proto__.getAddress = function () {
                if (!this._qtumWallet) {
                    this._qtumWallet = new QtumWallet(
                        `0x${this.privKey.toString('hex')}`,
                        qtumWalletOpts,
                    );
                }

                return Buffer.from(stripHexPrefix(this._qtumWallet.address), 'hex');
              };
            } catch (e) {
              console.error(e);
              throw e;
            }
          }

          return this._getAccounts().then(resolve).catch(reject);
        })
        .catch(reject);
    });
  };
  keyringType._monkeyPatched = true;
};

MetamaskController.prototype.monkeyPatchQTUMSetCurrency = async function () {
  const { ticker } = this.networkController.getProviderConfig();
  try {
    await this.currencyRateController.setNativeCurrency(ticker);
  } catch (error) {
    // TODO: Handle failure to get conversion rate more gracefully
    console.error(error);
  }
};

MetamaskController.prototype.monkeyPatchQTUMGetBalance = async function (
  _address,
) {
  const { rpcUrl } = this.networkController.getProviderConfig();
  try {
    const balances = await jsonRpcRequest(rpcUrl, 'qtum_getUTXOs', [
      _address,
      'all',
    ]);

    if (balances) {
      const spendableBalance = balances.reduce((sum, item) => {
        if (item.safe === true && (item.type === 'P2PKH' || item.type === 'P2PK')) {
          // eslint-disable-next-line no-param-reassign
          const b = new BigNumber(item.amount);
          sum = b.add(new BigNumber(sum));
        }
        return sum;
      }, 0);
      const bigBalance = new BigNumber(spendableBalance).times(
        new BigNumber(10).pow(18)
      );

      return addHexPrefix(bigBalance.toString(16));
    }
    return '0x00';
  } catch (error) {
    // TODO: Handle failure to get conversion rate more gracefully
    console.error(error);
  }
};

MetamaskController.prototype.updateQtumAccounts = async function (accounts) {
  if (accounts.length > 0) {
    await this.setQtumBalances(accounts[0]);
  }
  for (let i = 0; i < accounts.length; i++) {
    await this.setQtumAddressFromHexAddress(accounts[i]);
  }
}

MetamaskController.prototype.setQtumBalances = async function (account) {
  const { ticker } = this.networkController.getProviderConfig();
  if (ticker === 'QTUM') {
    const spendableQtumBalance = await this.monkeyPatchQTUMGetBalance(
      account,
    );
    await this.preferencesController.setQtumBalances(account, {spendableBalance: spendableQtumBalance});
  }
}

MetamaskController.prototype.getQtumAddressFromHexAddress = async function (_address) {
  const { ticker } = this.networkController.getProviderConfig();
  if (!_address.startsWith("0x")) {
    return _address;
  }
  try {
    if (ticker === 'QTUM') {
      const chainId = await this.networkController.getCurrentChainId();
      let version;
      switch (chainId) {
        case '0x22B8':
        case '0x22b8':
        case '0x51':
          version = 58;
          break;
        case '0x22B9':
        case '0x22b9':
          version = 120;
          break;
        default:
          version = 120;
          break;
      }
      const hash = Buffer.from(_address.slice(2), 'hex');
      return qtum.address.toBase58Check(hash, version);
    } else {
      return '0x00';
    }
  } catch(error) {
    console.error(error);
  }
}

MetamaskController.prototype.setQtumAddressFromHexAddress = async function (_address) {
  const { ticker } = this.networkController.getProviderConfig();
  if (ticker === 'QTUM') {
    const qtumAddress = await this.getQtumAddressFromHexAddress(
      _address,
    );
    await this.preferencesController.setQtumAddress(_address, qtumAddress);
  }
}

MetamaskController.prototype.getHexAddressFromQtumAddress = async function (_address) {
  const { ticker } = this.networkController.getProviderConfig();
  try {
    if (ticker === 'QTUM') {
      if (_address === undefined) {
        return 'Invalid Address'
      }
      const hexAddress = qtum.address.fromBase58Check(_address).hash.toString('hex')
      return `0x${hexAddress}`
    } else {
      return '0x00';
    }
  } catch(error) {
    console.error(error);
    return '0x00';
  }
}

MetamaskController.prototype.monkeyPatchHDKeyringAddNewKeyring = function () {
  const QTUM_BIP44_PATH = `m/44'/88'/0'/0`;
  if (this.keyringController.__proto__.hasOwnProperty('_addNewKeyring')) {
    return;
  }
  this.keyringController.__proto__._addNewKeyring = this.keyringController.__proto__.addNewKeyring;
  this.keyringController.__proto__.addNewKeyring = function(type, opts) {
    return new Promise((resolve, reject) => {
      if (type === 'HD Key Tree') {
        const SLIP_BIP44_PATH = `m/44'/2301'/0'/0`;
        opts = { ...opts, hdPath: SLIP_BIP44_PATH }
        return this._addNewKeyring(type, opts).then(resolve).catch(reject)
      } else {
        return this._addNewKeyring(type, opts).then(resolve).catch(reject)
      }
    })
  }
};

MetamaskController.prototype.MonekyPatchQTUMExportAccount = async function () {
  if (this.keyringController.__proto__.hasOwnProperty('_exportAccount')) {
    return;
  }
  let version;
  const { ticker } = this.networkController.getProviderConfig();
  if (ticker === 'QTUM') {
    const chainId = await this.networkController.getCurrentChainId();
    switch (chainId) {
      case '0x51':
      case '0x22B8':
      case '0x22b8':
        version = 0x80;
        break;
      case '0x22B9':
      case '0x22b9':
        version = 0xef ;
        break;
      default:
        version = 0xef;
        break;
    }
  } else {
    version = 0x80;
  }

  this.keyringController.__proto__._exportAccount = this.keyringController.__proto__.exportAccount;
  this.keyringController.__proto__.exportAccount = function (_address) {
    return new Promise((resolve, reject) => {
      this._exportAccount(_address)
        .then((privKey) => {
          const wallet = new QtumWallet(
            `0x${privKey.toString('hex')}`,
            qtumWalletOpts,
          );
          const buffer = toBuffer(wallet.privateKey);
          let wifKey = '';
          try {
            wifKey = wif.encode(version, buffer, true);
          } catch (err) {
            reject(err)
          }
          return resolve(wifKey)
        })
        .catch((e)=> {
          reject(e)
        });
    });
  };
}

MetamaskController.prototype.getHexAddressFromQtumAddress = async function (
  _address
) {
  const { ticker } = this.networkController.getProviderConfig();
  try {
    if (ticker === 'QTUM') {
      if (_address === undefined) {
        return 'Invalid Address';
      }
      const hexAddress = qtum.address.fromBase58Check(_address).hash.toString('hex')
      return `0x${hexAddress}`
    } else {
      return '0x00';
    }
    return '0x00';
  } catch (error) {
    console.error(error);
    return '0x00';
  }
}

MetamaskController.prototype.monkeyPatchHDKeyringAddNewKeyring = function () {
  const QTUM_BIP44_PATH = `m/44'/88'/0'/0`;
  if (this.keyringController.__proto__.hasOwnProperty('_addNewKeyring')) {
    return;
  }
  this.keyringController.__proto__._addNewKeyring = this.keyringController.__proto__.addNewKeyring;
  this.keyringController.__proto__.addNewKeyring = function(type, opts) {
    return new Promise((resolve, reject) => {
      if (type === 'HD Key Tree') {
        const SLIP_BIP44_PATH = `m/44'/2301'/0'/0`;
        opts = { ...opts, hdPath: SLIP_BIP44_PATH }
        return this._addNewKeyring(type, opts).then(resolve).catch(reject)
      } else {
        return this._addNewKeyring(type, opts).then(resolve).catch(reject)
      }
    })
  }
};

MetamaskController.prototype.monkeyPatchSimpleKeyringSignMessage = function() {
  if (this.keyringController.__proto__.hasOwnProperty('_signMessage')) {
    return;
  }
  this.keyringController.__proto__._signMessage = this.keyringController.__proto__.signMessage;
  this.keyringController.__proto__.signMessage = function (msgParams, opts = {}) {
    const address = normalize(msgParams.from);
    return this.getKeyringForAccount(address)
      .then(async (keyring) => {
        const message = stripHexPrefix(msgParams.data)
        const privKey = keyring.getPrivateKeyFor(address, opts);
        const wallet = new QtumWallet(privKey, qtumWalletOpts);
        const rawMsgSig = await (opts.btc ? wallet.signHashBtc : wallet.signHash).bind(wallet)(Buffer.from(message, "hex"));
        return Promise.resolve('0x' + rawMsgSig.toString('hex'));
      });
  }
}

MetamaskController.prototype.monkeyPatchSimpleKeyringSignPersonalMessage = function() {
  if (this.keyringController.__proto__.hasOwnProperty('_signPersonalMessage')) {
    return;
  }
  this.keyringController.__proto__._signPersonalMessage = this.keyringController.__proto__.signPersonalMessage;
  this.keyringController.__proto__.signPersonalMessage = function (msgParams, opts = {}) {
    const address = normalize(msgParams.from);
    return this.getKeyringForAccount(address)
      .then(async (keyring) => {
        const message = stripHexPrefix(msgParams.data)
        const privKey = keyring.getPrivateKeyFor(address, opts);
        const wallet = new QtumWallet(privKey, qtumWalletOpts);
        const rawMsgSig = await (opts.btc ? wallet.signMessageBtc : wallet.signMessage).bind(wallet)(Buffer.from(message, "hex"));
        return Promise.resolve('0x' + rawMsgSig.toString('hex'));
      });
  }
}

MetamaskController.prototype.monkeyPatchSimpleKeyringSignTypedMessage = function() {
    if (this.keyringController.__proto__.hasOwnProperty('_signTypedData')) {
      return;
    }
    this.keyringController.__proto__._signTypedData = true;

    for (let i = 0; i < this.keyringController.keyrings.length; i++) {
        const keyringType = this.keyringController.keyrings[i];
        if (!keyringType['_signTypedData_v1'] && keyringType.__proto__.signTypedData_v1) {
            keyringType.__proto__._signTypedData_v1 = keyringType.__proto__.signTypedData_v1;
            keyringType.__proto__.signTypedData_v1 = async function(withAccount, typedData, opts = {}) {
                const privKey = this.getPrivateKeyFor(withAccount, opts);
                const hash = toBuffer(typedSignatureHash(typedData));
                const wallet = new QtumWallet(
                    `0x${privKey.toString('hex')}`,
                    qtumWalletOpts,
                );
                const sig = await (opts.btc ? wallet.signHashBtc : wallet.signHash).bind(wallet)(hash);
                return "0x" + sig.toString('hex');
            }
        }

        if (!keyringType['_signTypedData_v3'] && keyringType.__proto__.signTypedData_v3) {
            keyringType.__proto__._signTypedData_v3 = keyringType.__proto__.signTypedData_v3;
            keyringType.__proto__.signTypedData_v3 = async function(withAccount, typedData, opts = {}) {
                const privKey = this.getPrivateKeyFor(withAccount, opts);
                const wallet = new QtumWallet(
                    `0x${privKey.toString('hex')}`,
                    qtumWalletOpts,
                );
                const types = Object.assign({}, typedData.types);
                delete types.EIP712Domain;

                const sig = await (opts.btc ? wallet._signTypedDataBtc : wallet._signTypedData).bind(wallet)(typedData.domain, types, typedData.message)
                return "0x" + sig.toString('hex');
            }
        }

        if (!keyringType['_signTypedData_v4'] && keyringType.__proto__.signTypedData_v4) {
            keyringType.__proto__._signTypedData_v4 = keyringType.__proto__.signTypedData_v4;
            keyringType.__proto__.signTypedData_v4 = async function(withAccount, typedData, opts = {}) {
                const privKey = this.getPrivateKeyFor(withAccount, opts);
                const wallet = new QtumWallet(
                    `0x${privKey.toString('hex')}`,
                    qtumWalletOpts,
                );
                const types = Object.assign({}, typedData.types);
                delete types.EIP712Domain;

                const sig = await (opts.btc ? wallet._signTypedDataBtc : wallet._signTypedData).bind(wallet)(typedData.domain, types, typedData.message)
                return "0x" + sig.toString('hex');
            }
        }
    }
}
