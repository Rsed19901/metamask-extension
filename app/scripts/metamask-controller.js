import EventEmitter from 'events';
import { finished, pipeline } from 'readable-stream';
import {
  AssetsContractController,
  CurrencyRateController,
  NftController,
  NftDetectionController,
  TokenDetectionController,
  TokenListController,
  TokenRatesController,
  TokensController,
  CodefiTokenPricesServiceV2,
  RatesController,
  fetchMultiExchangeRate,
  TokenBalancesController,
} from '@metamask/assets-controllers';
import { JsonRpcEngine } from '@metamask/json-rpc-engine';
import { createEngineStream } from '@metamask/json-rpc-middleware-stream';
import { ObservableStore } from '@metamask/obs-store';
import { storeAsStream } from '@metamask/obs-store/dist/asStream';
import { providerAsMiddleware } from '@metamask/eth-json-rpc-middleware';
import { debounce, throttle, memoize, wrap, pick } from 'lodash';
import {
  KeyringController,
  keyringBuilderFactory,
} from '@metamask/keyring-controller';
import createFilterMiddleware from '@metamask/eth-json-rpc-filters';
import createSubscriptionManager from '@metamask/eth-json-rpc-filters/subscriptionManager';
import { JsonRpcError, providerErrors } from '@metamask/rpc-errors';

import { Mutex } from 'await-semaphore';
import log from 'loglevel';
import {
  TrezorConnectBridge,
  TrezorKeyring,
} from '@metamask/eth-trezor-keyring';
import {
  LedgerKeyring,
  LedgerIframeBridge,
} from '@metamask/eth-ledger-bridge-keyring';
import LatticeKeyring from 'eth-lattice-keyring';
import { rawChainData } from 'eth-chainlist';
import { MetaMaskKeyring as QRHardwareKeyring } from '@keystonehq/metamask-airgapped-keyring';
import { nanoid } from 'nanoid';
import { captureException } from '@sentry/browser';
import { AddressBookController } from '@metamask/address-book-controller';
import {
  ApprovalController,
  ApprovalRequestNotFoundError,
} from '@metamask/approval-controller';
import { Messenger } from '@metamask/base-controller';
import { EnsController } from '@metamask/ens-controller';
import { PhishingController } from '@metamask/phishing-controller';
import { AnnouncementController } from '@metamask/announcement-controller';
import {
  NetworkController,
  getDefaultNetworkControllerState,
} from '@metamask/network-controller';
import { GasFeeController } from '@metamask/gas-fee-controller';
import {
  MethodNames,
  PermissionController,
  PermissionDoesNotExistError,
  PermissionsRequestNotFoundError,
  SubjectMetadataController,
  SubjectType,
} from '@metamask/permission-controller';
import SmartTransactionsController from '@metamask/smart-transactions-controller';
import { ClientId } from '@metamask/smart-transactions-controller/dist/types';
import {
  METAMASK_DOMAIN,
  SelectedNetworkController,
  createSelectedNetworkMiddleware,
} from '@metamask/selected-network-controller';
import { LoggingController, LogType } from '@metamask/logging-controller';
import { PermissionLogController } from '@metamask/permission-log-controller';

import {
  createSnapsMethodMiddleware,
  buildSnapEndowmentSpecifications,
  buildSnapRestrictedMethodSpecifications,
} from '@metamask/snaps-rpc-methods';
import {
  ApprovalType,
  ERC1155,
  ERC20,
  ERC721,
  BlockExplorerUrl,
} from '@metamask/controller-utils';

import { AccountsController } from '@metamask/accounts-controller';
import {
  RemoteFeatureFlagController,
  ClientConfigApiService,
  ClientType,
  DistributionType,
  EnvironmentType,
} from '@metamask/remote-feature-flag-controller';

///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
import {
  CUSTODIAN_TYPES,
  MmiConfigurationController,
} from '@metamask-institutional/custody-keyring';
import { InstitutionalFeaturesController } from '@metamask-institutional/institutional-features';
import { CustodyController } from '@metamask-institutional/custody-controller';
import { TransactionUpdateController } from '@metamask-institutional/transaction-update';
///: END:ONLY_INCLUDE_IF
import { SignatureController } from '@metamask/signature-controller';
import { wordlist } from '@metamask/scure-bip39/dist/wordlists/english';

import {
  NameController,
  ENSNameProvider,
  EtherscanNameProvider,
  TokenNameProvider,
  LensNameProvider,
} from '@metamask/name-controller';

import {
  QueuedRequestController,
  createQueuedRequestMiddleware,
} from '@metamask/queued-request-controller';

import { UserOperationController } from '@metamask/user-operation-controller';

import {
  TransactionStatus,
  TransactionType,
} from '@metamask/transaction-controller';

import { isSnapId } from '@metamask/snaps-utils';

import { Interface } from '@ethersproject/abi';
import { abiERC1155, abiERC721 } from '@metamask/metamask-eth-abis';
import { isEvmAccountType } from '@metamask/keyring-api';
import { hexToBigInt, toCaipChainId } from '@metamask/utils';
import { normalize } from '@metamask/eth-sig-util';
import {
  AuthenticationController,
  UserStorageController,
} from '@metamask/profile-sync-controller';
import {
  NotificationServicesPushController,
  NotificationServicesController,
} from '@metamask/notification-services-controller';
import {
  Caip25CaveatMutators,
  Caip25CaveatType,
  Caip25EndowmentPermissionName,
  getEthAccounts,
  setPermittedEthChainIds,
  setEthAccounts,
  addPermittedEthChainId,
} from '@metamask/multichain';
import { isProduction } from '../../shared/modules/environment';
import {
  methodsRequiringNetworkSwitch,
  methodsThatCanSwitchNetworkWithoutApproval,
  methodsThatShouldBeEnqueued,
} from '../../shared/constants/methods-tags';

///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
import { toChecksumHexAddress } from '../../shared/modules/hexstring-utils';
///: END:ONLY_INCLUDE_IF

import { AssetType, TokenStandard } from '../../shared/constants/transaction';
import {
  GAS_API_BASE_URL,
  GAS_DEV_API_BASE_URL,
  SWAPS_CLIENT_ID,
} from '../../shared/constants/swaps';
import {
  CHAIN_IDS,
  CHAIN_SPEC_URL,
  NETWORK_TYPES,
  NetworkStatus,
  MAINNET_DISPLAY_NAME,
} from '../../shared/constants/network';
import { getAllowedSmartTransactionsChainIds } from '../../shared/constants/smartTransactions';

import {
  HardwareDeviceNames,
  HardwareKeyringType,
  LedgerTransportTypes,
} from '../../shared/constants/hardware-wallets';
import { KeyringType } from '../../shared/constants/keyring';
import {
  RestrictedMethods,
  ExcludedSnapPermissions,
  ExcludedSnapEndowments,
  CaveatTypes,
} from '../../shared/constants/permissions';
import { UI_NOTIFICATIONS } from '../../shared/notifications';
import { MILLISECOND, MINUTE, SECOND } from '../../shared/constants/time';
import {
  ORIGIN_METAMASK,
  POLLING_TOKEN_ENVIRONMENT_TYPES,
} from '../../shared/constants/app';
import {
  MetaMetricsEventCategory,
  MetaMetricsEventName,
  MetaMetricsUserTrait,
} from '../../shared/constants/metametrics';
import { LOG_EVENT } from '../../shared/constants/logs';

import {
  getStorageItem,
  setStorageItem,
} from '../../shared/lib/storage-helpers';
import {
  getTokenIdParam,
  fetchTokenBalance,
  fetchERC1155Balance,
} from '../../shared/lib/token-util';
import { isEqualCaseInsensitive } from '../../shared/modules/string-utils';
import { parseStandardTokenTransactionData } from '../../shared/modules/transaction.utils';
import { STATIC_MAINNET_TOKEN_LIST } from '../../shared/constants/tokens';
import { getTokenValueParam } from '../../shared/lib/metamask-controller-utils';
import { isManifestV3 } from '../../shared/modules/mv3.utils';
import { convertNetworkId } from '../../shared/modules/network.utils';
import {
  getIsSmartTransaction,
  getFeatureFlagsByChainId,
} from '../../shared/modules/selectors';
import { createCaipStream } from '../../shared/modules/caip-stream';
import { BaseUrl } from '../../shared/constants/urls';
import {
  TOKEN_TRANSFER_LOG_TOPIC_HASH,
  TRANSFER_SINFLE_LOG_TOPIC_HASH,
} from '../../shared/lib/transactions-controller-utils';
import { getProviderConfig } from '../../shared/modules/selectors/networks';
import { endTrace, trace } from '../../shared/lib/trace';
import { BridgeStatusAction } from '../../shared/types/bridge-status';
import { ENVIRONMENT } from '../../development/build/constants';
import fetchWithCache from '../../shared/lib/fetch-with-cache';
import {
  BridgeUserAction,
  BridgeBackgroundAction,
} from '../../shared/types/bridge';
import {
  ///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
  handleMMITransactionUpdate,
  ///: END:ONLY_INCLUDE_IF
  createTransactionEventFragmentWithTxId,
} from './lib/transaction/metrics';
///: BEGIN:ONLY_INCLUDE_IF(keyring-snaps)
import { keyringSnapPermissionsBuilder } from './lib/snap-keyring/keyring-snaps-permissions';
///: END:ONLY_INCLUDE_IF

import { SnapsNameProvider } from './lib/SnapsNameProvider';
import { AddressBookPetnamesBridge } from './lib/AddressBookPetnamesBridge';
import { AccountIdentitiesPetnamesBridge } from './lib/AccountIdentitiesPetnamesBridge';
import { createPPOMMiddleware } from './lib/ppom/ppom-middleware';
import {
  onMessageReceived,
  checkForMultipleVersionsRunning,
} from './detect-multiple-instances';
///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
import { MMIController } from './controllers/mmi-controller';
import { mmiKeyringBuilderFactory } from './mmi-keyring-builder-factory';
///: END:ONLY_INCLUDE_IF
import ComposableObservableStore from './lib/ComposableObservableStore';
import AccountTrackerController from './controllers/account-tracker-controller';
import createDupeReqFilterStream from './lib/createDupeReqFilterStream';
import createLoggerMiddleware from './lib/createLoggerMiddleware';
import {
  createEthAccountsMethodMiddleware,
  createEip1193MethodMiddleware,
  createUnsupportedMethodMiddleware,
} from './lib/rpc-method-middleware';
import createOriginMiddleware from './lib/createOriginMiddleware';
import createMainFrameOriginMiddleware from './lib/createMainFrameOriginMiddleware';
import createTabIdMiddleware from './lib/createTabIdMiddleware';
import { NetworkOrderController } from './controllers/network-order';
import { AccountOrderController } from './controllers/account-order';
import createOnboardingMiddleware from './lib/createOnboardingMiddleware';
import { isStreamWritable, setupMultiplex } from './lib/stream-utils';
import { PreferencesController } from './controllers/preferences-controller';
import { AppStateController } from './controllers/app-state-controller';
import { AlertController } from './controllers/alert-controller';
import OnboardingController from './controllers/onboarding';
import Backup from './lib/backup';
import DecryptMessageController from './controllers/decrypt-message';
import SwapsController from './controllers/swaps';
import MetaMetricsController from './controllers/metametrics-controller';
import { segment } from './lib/segment';
import createMetaRPCHandler from './lib/createMetaRPCHandler';
import {
  addHexPrefix,
  getMethodDataName,
  previousValueComparator,
} from './lib/util';
import createMetamaskMiddleware from './lib/createMetamaskMiddleware';
import { hardwareKeyringBuilderFactory } from './lib/hardware-keyring-builder-factory';
import EncryptionPublicKeyController from './controllers/encryption-public-key';
import AppMetadataController from './controllers/app-metadata';

import {
  getCaveatSpecifications,
  diffMap,
  getPermissionBackgroundApiMethods,
  getPermissionSpecifications,
  getPermittedAccountsByOrigin,
  getPermittedChainsByOrigin,
  NOTIFICATION_NAMES,
  unrestrictedMethods,
  PermissionNames,
  validateCaveatAccounts,
  validateCaveatNetworks,
} from './controllers/permissions';
import { MetaMetricsDataDeletionController } from './controllers/metametrics-data-deletion/metametrics-data-deletion';
import { DataDeletionService } from './services/data-deletion-service';
import createRPCMethodTrackingMiddleware from './lib/createRPCMethodTrackingMiddleware';
import { updateCurrentLocale } from './translate';
import { TrezorOffscreenBridge } from './lib/offscreen-bridge/trezor-offscreen-bridge';
import { LedgerOffscreenBridge } from './lib/offscreen-bridge/ledger-offscreen-bridge';
///: BEGIN:ONLY_INCLUDE_IF(keyring-snaps)
import { snapKeyringBuilder, getAccountsBySnapId } from './lib/snap-keyring';
///: END:ONLY_INCLUDE_IF
import { encryptorFactory } from './lib/encryptor-factory';
import { addDappTransaction, addTransaction } from './lib/transaction/util';
///: BEGIN:ONLY_INCLUDE_IF(build-main,build-beta,build-flask)
import { addTypedMessage, addPersonalMessage } from './lib/signature/util';
///: END:ONLY_INCLUDE_IF
import { LatticeKeyringOffscreen } from './lib/offscreen-bridge/lattice-offscreen-keyring';
import { WeakRefObjectMap } from './lib/WeakRefObjectMap';
import { METAMASK_COOKIE_HANDLER } from './constants/stream';

// Notification controllers
import { createTxVerificationMiddleware } from './lib/tx-verification/tx-verification-middleware';
import { updateSecurityAlertResponse } from './lib/ppom/ppom-util';
import createEvmMethodsToNonEvmAccountReqFilterMiddleware from './lib/createEvmMethodsToNonEvmAccountReqFilterMiddleware';
import { isEthAddress } from './lib/multichain/address';
import { decodeTransactionData } from './lib/transaction/decode/util';
import BridgeController from './controllers/bridge/bridge-controller';
import { BRIDGE_CONTROLLER_NAME } from './controllers/bridge/constants';
import {
  onPushNotificationClicked,
  onPushNotificationReceived,
} from './controllers/push-notifications';
import createTracingMiddleware from './lib/createTracingMiddleware';
import createOriginThrottlingMiddleware from './lib/createOriginThrottlingMiddleware';
import { PatchStore } from './lib/PatchStore';
import { sanitizeUIState } from './lib/state-utils';
import BridgeStatusController from './controllers/bridge-status/bridge-status-controller';
import { BRIDGE_STATUS_CONTROLLER_NAME } from './controllers/bridge-status/constants';
import { rejectAllApprovals } from './lib/approval/utils';
import {
  handleBridgeTransactionComplete,
  handleBridgeTransactionFailed,
  handleTransactionFailedTypeBridge,
} from './lib/bridge-status/metrics';
///: BEGIN:ONLY_INCLUDE_IF(build-flask)
import {
  MultichainAssetsControllerInit,
  MultichainTransactionsControllerInit,
  MultichainBalancesControllerInit,
  MultiChainAssetsRatesControllerInit,
} from './controller-init/multichain';
///: END:ONLY_INCLUDE_IF
import { TransactionControllerInit } from './controller-init/confirmations/transaction-controller-init';
import { PPOMControllerInit } from './controller-init/confirmations/ppom-controller-init';
import { initControllers } from './controller-init/utils';
import {
  CronjobControllerInit,
  ExecutionServiceInit,
  RateLimitControllerInit,
  SnapControllerInit,
  SnapInsightsControllerInit,
  SnapInterfaceControllerInit,
  SnapsRegistryInit,
} from './controller-init/snaps';

const { TRIGGER_TYPES } = NotificationServicesController.Constants;
export const METAMASK_CONTROLLER_EVENTS = {
  // Fired after state changes that impact the extension badge (unapproved msg count)
  // The process of updating the badge happens in app/scripts/background.js.
  UPDATE_BADGE: 'updateBadge',
  DECRYPT_MESSAGE_MANAGER_UPDATE_BADGE: 'DecryptMessageManager:updateBadge',
  ENCRYPTION_PUBLIC_KEY_MANAGER_UPDATE_BADGE:
    'EncryptionPublicKeyManager:updateBadge',
  // TODO: Add this and similar enums to the `controllers` repo and export them
  APPROVAL_STATE_CHANGE: 'ApprovalController:stateChange',
  APP_STATE_UNLOCK_CHANGE: 'AppStateController:unlockChange',
  QUEUED_REQUEST_STATE_CHANGE: 'QueuedRequestController:stateChange',
  METAMASK_NOTIFICATIONS_LIST_UPDATED:
    'NotificationServicesController:notificationsListUpdated',
  METAMASK_NOTIFICATIONS_MARK_AS_READ:
    'NotificationServicesController:markNotificationsAsRead',
};

// stream channels
const PHISHING_SAFELIST = 'metamask-phishing-safelist';

// OneKey devices can connect to Metamask using Trezor USB transport. They use a specific device minor version (99) to differentiate between genuine Trezor and OneKey devices.
export const ONE_KEY_VIA_TREZOR_MINOR_VERSION = 99;

const environmentMappingForRemoteFeatureFlag = {
  [ENVIRONMENT.DEVELOPMENT]: EnvironmentType.Development,
  [ENVIRONMENT.RELEASE_CANDIDATE]: EnvironmentType.ReleaseCandidate,
  [ENVIRONMENT.PRODUCTION]: EnvironmentType.Production,
};

const buildTypeMappingForRemoteFeatureFlag = {
  flask: DistributionType.Flask,
  main: DistributionType.Main,
};

export default class MetamaskController extends EventEmitter {
  /**
   * @param {object} opts
   */
  constructor(opts) {
    super();

    const { isFirstMetaMaskControllerSetup } = opts;

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
    const version = process.env.METAMASK_VERSION;
    this.recordFirstTimeInfo(initState);
    this.featureFlags = opts.featureFlags;

    // this keeps track of how many "controllerStream" connections are open
    // the only thing that uses controller connections are open metamask UI instances
    this.activeControllerConnections = 0;

    this.offscreenPromise = opts.offscreenPromise ?? Promise.resolve();

    this.getRequestAccountTabIds = opts.getRequestAccountTabIds;
    this.getOpenMetamaskTabsIds = opts.getOpenMetamaskTabsIds;

    this.initializeChainlist();

    this.controllerMessenger = new Messenger();

    this.loggingController = new LoggingController({
      messenger: this.controllerMessenger.getRestricted({
        name: 'LoggingController',
        allowedActions: [],
        allowedEvents: [],
      }),
      state: initState.LoggingController,
    });

    // instance of a class that wraps the extension's storage local API.
    this.localStoreApiWrapper = opts.persistanceManager;

    this.currentMigrationVersion = opts.currentMigrationVersion;

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
      if (details.reason === 'update') {
        if (version === '8.1.0') {
          this.platform.openExtensionInBrowser();
        }
        this.loggingController.add({
          type: LogType.GenericLog,
          data: {
            event: LOG_EVENT.VERSION_UPDATE,
            previousVersion: details.previousVersion,
            version,
          },
        });
      }
    });

    this.appMetadataController = new AppMetadataController({
      state: initState.AppMetadataController,
      messenger: this.controllerMessenger.getRestricted({
        name: 'AppMetadataController',
        allowedActions: [],
        allowedEvents: [],
      }),
      currentMigrationVersion: this.currentMigrationVersion,
      currentAppVersion: version,
    });

    // next, we will initialize the controllers
    // controller initialization order matters
    const clearPendingConfirmations = () => {
      this.encryptionPublicKeyController.clearUnapproved();
      this.decryptMessageController.clearUnapproved();
      this.signatureController.clearUnapproved();
      this.approvalController.clear(providerErrors.userRejectedRequest());
    };

    this.approvalController = new ApprovalController({
      messenger: this.controllerMessenger.getRestricted({
        name: 'ApprovalController',
      }),
      showApprovalRequest: opts.showUserConfirmation,
      typesExcludedFromRateLimiting: [
        ApprovalType.PersonalSign,
        ApprovalType.EthSignTypedData,
        ApprovalType.Transaction,
        ApprovalType.WatchAsset,
        ApprovalType.EthGetEncryptionPublicKey,
        ApprovalType.EthDecrypt,
      ],
    });

    this.queuedRequestController = new QueuedRequestController({
      messenger: this.controllerMessenger.getRestricted({
        name: 'QueuedRequestController',
        allowedActions: [
          'NetworkController:getState',
          'NetworkController:setActiveNetwork',
          'SelectedNetworkController:getNetworkClientIdForDomain',
        ],
        allowedEvents: ['SelectedNetworkController:stateChange'],
      }),
      shouldRequestSwitchNetwork: ({ method }) =>
        methodsRequiringNetworkSwitch.includes(method),
      canRequestSwitchNetworkWithoutApproval: ({ method }) =>
        methodsThatCanSwitchNetworkWithoutApproval.includes(method),
      clearPendingConfirmations,
      showApprovalRequest: () => {
        if (this.approvalController.getTotalApprovalCount() > 0) {
          opts.showUserConfirmation();
        }
      },
    });

    ///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
    this.mmiConfigurationController = new MmiConfigurationController({
      initState: initState.MmiConfigurationController,
      mmiConfigurationServiceUrl: process.env.MMI_CONFIGURATION_SERVICE_URL,
    });
    ///: END:ONLY_INCLUDE_IF

    const networkControllerMessenger = this.controllerMessenger.getRestricted({
      name: 'NetworkController',
    });

    let initialNetworkControllerState = initState.NetworkController;
    if (!initialNetworkControllerState) {
      initialNetworkControllerState = getDefaultNetworkControllerState();

      const networks =
        initialNetworkControllerState.networkConfigurationsByChainId;

      // Note: Consider changing `getDefaultNetworkControllerState`
      // on the controller side to include some of these tweaks.
      networks[CHAIN_IDS.MAINNET].name = MAINNET_DISPLAY_NAME;
      delete networks[CHAIN_IDS.GOERLI];
      delete networks[CHAIN_IDS.LINEA_GOERLI];

      Object.values(networks).forEach((network) => {
        const id = network.rpcEndpoints[0].networkClientId;
        network.blockExplorerUrls = [BlockExplorerUrl[id]];
        network.defaultBlockExplorerUrlIndex = 0;
      });

      let network;
      if (process.env.IN_TEST) {
        network = {
          chainId: CHAIN_IDS.LOCALHOST,
          name: 'Localhost 8545',
          nativeCurrency: 'ETH',
          blockExplorerUrls: [],
          defaultRpcEndpointIndex: 0,
          rpcEndpoints: [
            {
              networkClientId: 'networkConfigurationId',
              url: 'http://localhost:8545',
              type: 'custom',
            },
          ],
        };
        networks[CHAIN_IDS.LOCALHOST] = network;
      } else if (
        process.env.METAMASK_DEBUG ||
        process.env.METAMASK_ENVIRONMENT === 'test'
      ) {
        network = networks[CHAIN_IDS.SEPOLIA];
      } else {
        network = networks[CHAIN_IDS.MAINNET];
      }

      initialNetworkControllerState.selectedNetworkClientId =
        network.rpcEndpoints[network.defaultRpcEndpointIndex].networkClientId;
    }

    this.networkController = new NetworkController({
      messenger: networkControllerMessenger,
      state: initialNetworkControllerState,
      infuraProjectId: opts.infuraProjectId,
    });
    this.networkController.initializeProvider();
    this.provider =
      this.networkController.getProviderAndBlockTracker().provider;
    this.blockTracker =
      this.networkController.getProviderAndBlockTracker().blockTracker;
    this.deprecatedNetworkVersions = {};

    const accountsControllerMessenger = this.controllerMessenger.getRestricted({
      name: 'AccountsController',
      allowedEvents: [
        'SnapController:stateChange',
        'KeyringController:accountRemoved',
        'KeyringController:stateChange',
        'SnapKeyring:accountAssetListUpdated',
        'SnapKeyring:accountBalancesUpdated',
        'SnapKeyring:accountTransactionsUpdated',
      ],
      allowedActions: [
        'KeyringController:getAccounts',
        'KeyringController:getKeyringsByType',
        'KeyringController:getKeyringForAccount',
      ],
    });

    this.accountsController = new AccountsController({
      messenger: accountsControllerMessenger,
      state: initState.AccountsController,
    });

    const preferencesMessenger = this.controllerMessenger.getRestricted({
      name: 'PreferencesController',
      allowedActions: [
        'AccountsController:setSelectedAccount',
        'AccountsController:getSelectedAccount',
        'AccountsController:getAccountByAddress',
        'AccountsController:setAccountName',
        'NetworkController:getState',
      ],
      allowedEvents: ['AccountsController:stateChange'],
    });

    this.preferencesController = new PreferencesController({
      state: {
        currentLocale: opts.initLangCode ?? '',
        ...initState.PreferencesController,
      },
      messenger: preferencesMessenger,
    });

    const tokenListMessenger = this.controllerMessenger.getRestricted({
      name: 'TokenListController',
      allowedActions: ['NetworkController:getNetworkClientById'],
      allowedEvents: ['NetworkController:stateChange'],
    });

    this.tokenListController = new TokenListController({
      chainId: this.#getGlobalChainId({
        metamask: this.networkController.state,
      }),
      preventPollingOnNetworkRestart: !this.#isTokenListPollingRequired(
        this.preferencesController.state,
      ),
      messenger: tokenListMessenger,
      state: initState.TokenListController,
    });

    const assetsContractControllerMessenger =
      this.controllerMessenger.getRestricted({
        name: 'AssetsContractController',
        allowedActions: [
          'NetworkController:getNetworkClientById',
          'NetworkController:getNetworkConfigurationByNetworkClientId',
          'NetworkController:getSelectedNetworkClient',
          'NetworkController:getState',
        ],
        allowedEvents: [
          'PreferencesController:stateChange',
          'NetworkController:networkDidChange',
        ],
      });
    this.assetsContractController = new AssetsContractController({
      messenger: assetsContractControllerMessenger,
      chainId: this.#getGlobalChainId(),
    });

    const tokensControllerMessenger = this.controllerMessenger.getRestricted({
      name: 'TokensController',
      allowedActions: [
        'ApprovalController:addRequest',
        'NetworkController:getNetworkClientById',
        'AccountsController:getSelectedAccount',
        'AccountsController:getAccount',
      ],
      allowedEvents: [
        'NetworkController:networkDidChange',
        'AccountsController:selectedEvmAccountChange',
        'PreferencesController:stateChange',
        'TokenListController:stateChange',
        'NetworkController:stateChange',
      ],
    });
    this.tokensController = new TokensController({
      state: initState.TokensController,
      provider: this.provider,
      messenger: tokensControllerMessenger,
      chainId: this.#getGlobalChainId(),
    });

    const nftControllerMessenger = this.controllerMessenger.getRestricted({
      name: 'NftController',
      allowedEvents: [
        'PreferencesController:stateChange',
        'NetworkController:networkDidChange',
        'AccountsController:selectedEvmAccountChange',
      ],
      allowedActions: [
        `${this.approvalController.name}:addRequest`,
        `${this.networkController.name}:getNetworkClientById`,
        'AccountsController:getSelectedAccount',
        'AccountsController:getAccount',
        'AssetsContractController:getERC721AssetName',
        'AssetsContractController:getERC721AssetSymbol',
        'AssetsContractController:getERC721TokenURI',
        'AssetsContractController:getERC721OwnerOf',
        'AssetsContractController:getERC1155BalanceOf',
        'AssetsContractController:getERC1155TokenURI',
      ],
    });
    this.nftController = new NftController({
      state: initState.NftController,
      messenger: nftControllerMessenger,
      chainId: this.#getGlobalChainId(),
      onNftAdded: ({ address, symbol, tokenId, standard, source }) =>
        this.metaMetricsController.trackEvent({
          event: MetaMetricsEventName.NftAdded,
          category: MetaMetricsEventCategory.Wallet,
          sensitiveProperties: {
            token_contract_address: address,
            token_symbol: symbol,
            token_id: tokenId,
            token_standard: standard,
            asset_type: AssetType.NFT,
            source,
          },
        }),
    });

    const nftDetectionControllerMessenger =
      this.controllerMessenger.getRestricted({
        name: 'NftDetectionController',
        allowedEvents: [
          'NetworkController:stateChange',
          'PreferencesController:stateChange',
        ],
        allowedActions: [
          'ApprovalController:addRequest',
          'NetworkController:getState',
          'NetworkController:getNetworkClientById',
          'AccountsController:getSelectedAccount',
        ],
      });

    this.nftDetectionController = new NftDetectionController({
      messenger: nftDetectionControllerMessenger,
      chainId: this.#getGlobalChainId(),
      getOpenSeaApiKey: () => this.nftController.openSeaApiKey,
      getBalancesInSingleCall:
        this.assetsContractController.getBalancesInSingleCall.bind(
          this.assetsContractController,
        ),
      addNft: this.nftController.addNft.bind(this.nftController),
      getNftState: () => this.nftController.state,
      // added this to track previous value of useNftDetection, should be true on very first initializing of controller[]
      disabled: !this.preferencesController.state.useNftDetection,
    });

    const metaMetricsControllerMessenger =
      this.controllerMessenger.getRestricted({
        name: 'MetaMetricsController',
        allowedActions: [
          'PreferencesController:getState',
          'NetworkController:getState',
          'NetworkController:getNetworkClientById',
        ],
        allowedEvents: [
          'PreferencesController:stateChange',
          'NetworkController:networkDidChange',
        ],
      });
    this.metaMetricsController = new MetaMetricsController({
      state: initState.MetaMetricsController,
      messenger: metaMetricsControllerMessenger,
      segment,
      version: process.env.METAMASK_VERSION,
      environment: process.env.METAMASK_ENVIRONMENT,
      extension: this.extension,
      captureException,
    });

    this.on('update', (update) => {
      this.metaMetricsController.handleMetaMaskStateUpdate(update);
    });

    const dataDeletionService = new DataDeletionService();
    const metaMetricsDataDeletionMessenger =
      this.controllerMessenger.getRestricted({
        name: 'MetaMetricsDataDeletionController',
        allowedActions: ['MetaMetricsController:getState'],
        allowedEvents: [],
      });
    this.metaMetricsDataDeletionController =
      new MetaMetricsDataDeletionController({
        dataDeletionService,
        messenger: metaMetricsDataDeletionMessenger,
        state: initState.metaMetricsDataDeletionController,
      });

    const gasFeeMessenger = this.controllerMessenger.getRestricted({
      name: 'GasFeeController',
      allowedActions: [
        'NetworkController:getEIP1559Compatibility',
        'NetworkController:getNetworkClientById',
        'NetworkController:getState',
      ],
      allowedEvents: ['NetworkController:stateChange'],
    });

    const gasApiBaseUrl = process.env.SWAPS_USE_DEV_APIS
      ? GAS_DEV_API_BASE_URL
      : GAS_API_BASE_URL;

    this.gasFeeController = new GasFeeController({
      state: initState.GasFeeController,
      interval: 10000,
      messenger: gasFeeMessenger,
      clientId: SWAPS_CLIENT_ID,
      getProvider: () =>
        this.networkController.getProviderAndBlockTracker().provider,
      onNetworkDidChange: (eventHandler) => {
        networkControllerMessenger.subscribe(
          'NetworkController:networkDidChange',
          () => eventHandler(this.networkController.state),
        );
      },
      getCurrentNetworkEIP1559Compatibility:
        this.networkController.getEIP1559Compatibility.bind(
          this.networkController,
        ),
      getCurrentAccountEIP1559Compatibility:
        this.getCurrentAccountEIP1559Compatibility.bind(this),
      legacyAPIEndpoint: `${gasApiBaseUrl}/networks/<chain_id>/gasPrices`,
      EIP1559APIEndpoint: `${gasApiBaseUrl}/networks/<chain_id>/suggestedGasFees`,
      getCurrentNetworkLegacyGasAPICompatibility: () => {
        const chainId = this.#getGlobalChainId();
        return chainId === CHAIN_IDS.BSC;
      },
      getChainId: () => this.#getGlobalChainId(),
    });

    this.appStateController = new AppStateController({
      addUnlockListener: this.on.bind(this, 'unlock'),
      isUnlocked: this.isUnlocked.bind(this),
      state: initState.AppStateController,
      onInactiveTimeout: () => this.setLocked(),
      messenger: this.controllerMessenger.getRestricted({
        name: 'AppStateController',
        allowedActions: [
          `${this.approvalController.name}:addRequest`,
          `${this.approvalController.name}:acceptRequest`,
          `PreferencesController:getState`,
        ],
        allowedEvents: [
          `KeyringController:qrKeyringStateChange`,
          'PreferencesController:stateChange',
        ],
      }),
      extension: this.extension,
    });

    const currencyRateMessenger = this.controllerMessenger.getRestricted({
      name: 'CurrencyRateController',
      allowedActions: [`${this.networkController.name}:getNetworkClientById`],
    });
    this.currencyRateController = new CurrencyRateController({
      includeUsdRate: true,
      messenger: currencyRateMessenger,
      state: initState.CurrencyController,
    });
    const initialFetchMultiExchangeRate =
      this.currencyRateController.fetchMultiExchangeRate.bind(
        this.currencyRateController,
      );
    this.currencyRateController.fetchMultiExchangeRate = (...args) => {
      if (this.preferencesController.state.useCurrencyRateCheck) {
        return initialFetchMultiExchangeRate(...args);
      }
      return {
        conversionRate: null,
        usdConversionRate: null,
      };
    };

    const tokenBalancesMessenger = this.controllerMessenger.getRestricted({
      name: 'TokenBalancesController',
      allowedActions: [
        'NetworkController:getState',
        'NetworkController:getNetworkClientById',
        'TokensController:getState',
        'PreferencesController:getState',
        'AccountsController:getSelectedAccount',
      ],
      allowedEvents: [
        'PreferencesController:stateChange',
        'TokensController:stateChange',
        'NetworkController:stateChange',
      ],
    });

    this.tokenBalancesController = new TokenBalancesController({
      messenger: tokenBalancesMessenger,
      state: initState.TokenBalancesController,
      interval: 30000,
    });

    const phishingControllerMessenger = this.controllerMessenger.getRestricted({
      name: 'PhishingController',
    });

    this.phishingController = new PhishingController({
      messenger: phishingControllerMessenger,
      state: initState.PhishingController,
      hotlistRefreshInterval: process.env.IN_TEST ? 5 * SECOND : undefined,
      stalelistRefreshInterval: process.env.IN_TEST ? 30 * SECOND : undefined,
    });

    const announcementMessenger = this.controllerMessenger.getRestricted({
      name: 'AnnouncementController',
    });

    this.announcementController = new AnnouncementController({
      messenger: announcementMessenger,
      allAnnouncements: UI_NOTIFICATIONS,
      state: initState.AnnouncementController,
    });

    const networkOrderMessenger = this.controllerMessenger.getRestricted({
      name: 'NetworkOrderController',
      allowedEvents: ['NetworkController:stateChange'],
    });
    this.networkOrderController = new NetworkOrderController({
      messenger: networkOrderMessenger,
      state: initState.NetworkOrderController,
    });

    const accountOrderMessenger = this.controllerMessenger.getRestricted({
      name: 'AccountOrderController',
    });
    this.accountOrderController = new AccountOrderController({
      messenger: accountOrderMessenger,
      state: initState.AccountOrderController,
    });

    const multichainRatesControllerMessenger =
      this.controllerMessenger.getRestricted({
        name: 'RatesController',
      });
    this.multichainRatesController = new RatesController({
      state: initState.MultichainRatesController,
      messenger: multichainRatesControllerMessenger,
      includeUsdRate: true,
      fetchMultiExchangeRate,
    });

    const tokenRatesMessenger = this.controllerMessenger.getRestricted({
      name: 'TokenRatesController',
      allowedActions: [
        'TokensController:getState',
        'NetworkController:getNetworkClientById',
        'NetworkController:getState',
        'AccountsController:getAccount',
        'AccountsController:getSelectedAccount',
      ],
      allowedEvents: [
        'NetworkController:stateChange',
        'AccountsController:selectedEvmAccountChange',
        'PreferencesController:stateChange',
        'TokensController:stateChange',
      ],
    });

    // token exchange rate tracker
    this.tokenRatesController = new TokenRatesController({
      state: initState.TokenRatesController,
      messenger: tokenRatesMessenger,
      tokenPricesService: new CodefiTokenPricesServiceV2(),
      disabled: !this.preferencesController.state.useCurrencyRateCheck,
    });

    this.controllerMessenger.subscribe(
      'PreferencesController:stateChange',
      previousValueComparator((prevState, currState) => {
        const { useCurrencyRateCheck: prevUseCurrencyRateCheck } = prevState;
        const { useCurrencyRateCheck: currUseCurrencyRateCheck } = currState;
        if (currUseCurrencyRateCheck && !prevUseCurrencyRateCheck) {
          this.tokenRatesController.enable();
        } else if (!currUseCurrencyRateCheck && prevUseCurrencyRateCheck) {
          this.tokenRatesController.disable();
        }
      }, this.preferencesController.state),
    );

    this.ensController = new EnsController({
      messenger: this.controllerMessenger.getRestricted({
        name: 'EnsController',
        allowedActions: [
          'NetworkController:getNetworkClientById',
          'NetworkController:getState',
        ],
        allowedEvents: [],
      }),
      onNetworkDidChange: networkControllerMessenger.subscribe.bind(
        networkControllerMessenger,
        'NetworkController:networkDidChange',
      ),
    });

    const onboardingControllerMessenger =
      this.controllerMessenger.getRestricted({
        name: 'OnboardingController',
        allowedActions: [],
        allowedEvents: [],
      });
    this.onboardingController = new OnboardingController({
      messenger: onboardingControllerMessenger,
      state: initState.OnboardingController,
    });

    let additionalKeyrings = [keyringBuilderFactory(QRHardwareKeyring)];

    const keyringOverrides = this.opts.overrides?.keyrings;

    if (isManifestV3 === false) {
      const additionalKeyringTypes = [
        keyringOverrides?.lattice || LatticeKeyring,
        QRHardwareKeyring,
      ];

      const additionalBridgedKeyringTypes = [
        {
          keyring: keyringOverrides?.trezor || TrezorKeyring,
          bridge: keyringOverrides?.trezorBridge || TrezorConnectBridge,
        },
        {
          keyring: keyringOverrides?.ledger || LedgerKeyring,
          bridge: keyringOverrides?.ledgerBridge || LedgerIframeBridge,
        },
      ];

      additionalKeyrings = additionalKeyringTypes.map((keyringType) =>
        keyringBuilderFactory(keyringType),
      );

      additionalBridgedKeyringTypes.forEach((keyringType) =>
        additionalKeyrings.push(
          hardwareKeyringBuilderFactory(
            keyringType.keyring,
            keyringType.bridge,
          ),
        ),
      );
    } else {
      additionalKeyrings.push(
        hardwareKeyringBuilderFactory(
          TrezorKeyring,
          keyringOverrides?.trezorBridge || TrezorOffscreenBridge,
        ),
        hardwareKeyringBuilderFactory(
          LedgerKeyring,
          keyringOverrides?.ledgerBridge || LedgerOffscreenBridge,
        ),
        keyringBuilderFactory(LatticeKeyringOffscreen),
      );
    }

    ///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
    for (const custodianType of Object.keys(CUSTODIAN_TYPES)) {
      additionalKeyrings.push(
        mmiKeyringBuilderFactory(CUSTODIAN_TYPES[custodianType].keyringClass, {
          mmiConfigurationController: this.mmiConfigurationController,
          captureException,
        }),
      );
    }
    ///: END:ONLY_INCLUDE_IF

    ///: BEGIN:ONLY_INCLUDE_IF(keyring-snaps)
    const snapKeyringBuildMessenger = this.controllerMessenger.getRestricted({
      name: 'SnapKeyring',
      allowedActions: [
        'ApprovalController:addRequest',
        'ApprovalController:acceptRequest',
        'ApprovalController:rejectRequest',
        'ApprovalController:startFlow',
        'ApprovalController:endFlow',
        'ApprovalController:showSuccess',
        'ApprovalController:showError',
        'PhishingController:test',
        'PhishingController:maybeUpdateState',
        'KeyringController:getAccounts',
        'AccountsController:setSelectedAccount',
        'AccountsController:getAccountByAddress',
        'AccountsController:setAccountName',
        'SnapController:handleRequest',
        'SnapController:get',
        'PreferencesController:getState',
      ],
    });

    // Necessary to persist the keyrings and update the accounts both within the keyring controller and accounts controller
    const persistAndUpdateAccounts = async () => {
      await this.keyringController.persistAllKeyrings();
      await this.accountsController.updateAccounts();
    };

    additionalKeyrings.push(
      snapKeyringBuilder(snapKeyringBuildMessenger, {
        persistKeyringHelper: () => persistAndUpdateAccounts(),
        removeAccountHelper: (address) => this.removeAccount(address),
        trackEvent: (...args) => this.metaMetricsController.trackEvent(...args),
      }),
    );

    ///: END:ONLY_INCLUDE_IF

    const keyringControllerMessenger = this.controllerMessenger.getRestricted({
      name: 'KeyringController',
    });

    this.keyringController = new KeyringController({
      cacheEncryptionKey: true,
      keyringBuilders: additionalKeyrings,
      state: initState.KeyringController,
      encryptor: opts.encryptor || encryptorFactory(600_000),
      messenger: keyringControllerMessenger,
    });

    this.controllerMessenger.subscribe('KeyringController:unlock', () =>
      this._onUnlock(),
    );
    this.controllerMessenger.subscribe('KeyringController:lock', () =>
      this._onLock(),
    );

    this.controllerMessenger.subscribe(
      'KeyringController:stateChange',
      (state) => {
        this._onKeyringControllerUpdate(state);
      },
    );

    this.permissionController = new PermissionController({
      messenger: this.controllerMessenger.getRestricted({
        name: 'PermissionController',
        allowedActions: [
          `${this.approvalController.name}:addRequest`,
          `${this.approvalController.name}:hasRequest`,
          `${this.approvalController.name}:acceptRequest`,
          `${this.approvalController.name}:rejectRequest`,
          `SnapController:getPermitted`,
          `SnapController:install`,
          `SubjectMetadataController:getSubjectMetadata`,
        ],
      }),
      state: initState.PermissionController,
      caveatSpecifications: getCaveatSpecifications({
        listAccounts: this.accountsController.listAccounts.bind(
          this.accountsController,
        ),
        findNetworkClientIdByChainId:
          this.networkController.findNetworkClientIdByChainId.bind(
            this.networkController,
          ),
      }),
      permissionSpecifications: {
        ...getPermissionSpecifications(),
        ...this.getSnapPermissionSpecifications(),
      },
      unrestrictedMethods,
    });

    this.selectedNetworkController = new SelectedNetworkController({
      messenger: this.controllerMessenger.getRestricted({
        name: 'SelectedNetworkController',
        allowedActions: [
          'NetworkController:getNetworkClientById',
          'NetworkController:getState',
          'NetworkController:getSelectedNetworkClient',
          'PermissionController:hasPermissions',
          'PermissionController:getSubjectNames',
        ],
        allowedEvents: [
          'NetworkController:stateChange',
          'PermissionController:stateChange',
        ],
      }),
      state: initState.SelectedNetworkController,
      useRequestQueuePreference: true,
      onPreferencesStateChange: () => {
        // noop
        // we have removed the ability to toggle the useRequestQueue preference
        // both useRequestQueue and onPreferencesStateChange will be removed
        // once mobile supports per dapp network selection
        // see https://github.com/MetaMask/core/pull/5065#issue-2736965186
      },
      domainProxyMap: new WeakRefObjectMap(),
    });

    this.permissionLogController = new PermissionLogController({
      messenger: this.controllerMessenger.getRestricted({
        name: 'PermissionLogController',
      }),
      restrictedMethods: new Set(Object.keys(RestrictedMethods)),
      state: initState.PermissionLogController,
    });

    this.subjectMetadataController = new SubjectMetadataController({
      messenger: this.controllerMessenger.getRestricted({
        name: 'SubjectMetadataController',
        allowedActions: [`${this.permissionController.name}:hasPermissions`],
      }),
      state: initState.SubjectMetadataController,
      subjectCacheLimit: 100,
    });

    // Notification Controllers
    this.authenticationController = new AuthenticationController.Controller({
      state: initState.AuthenticationController,
      messenger: this.controllerMessenger.getRestricted({
        name: 'AuthenticationController',
        allowedActions: [
          'KeyringController:getState',
          'SnapController:handleRequest',
        ],
        allowedEvents: ['KeyringController:lock', 'KeyringController:unlock'],
      }),
      metametrics: {
        getMetaMetricsId: () => this.metaMetricsController.getMetaMetricsId(),
        agent: 'extension',
      },
    });

    this.userStorageController = new UserStorageController.Controller({
      state: initState.UserStorageController,
      config: {
        accountSyncing: {
          onAccountAdded: (profileId) => {
            this.metaMetricsController.trackEvent({
              category: MetaMetricsEventCategory.ProfileSyncing,
              event: MetaMetricsEventName.AccountsSyncAdded,
              properties: {
                profile_id: profileId,
              },
            });
          },
          onAccountNameUpdated: (profileId) => {
            this.metaMetricsController.trackEvent({
              category: MetaMetricsEventCategory.ProfileSyncing,
              event: MetaMetricsEventName.AccountsSyncNameUpdated,
              properties: {
                profile_id: profileId,
              },
            });
          },
          onAccountSyncErroneousSituation: (
            profileId,
            situationMessage,
            sentryContext,
          ) => {
            captureException(
              new Error(`Account sync - ${situationMessage}`),
              sentryContext,
            );
            this.metaMetricsController.trackEvent({
              category: MetaMetricsEventCategory.ProfileSyncing,
              event: MetaMetricsEventName.AccountsSyncErroneousSituation,
              properties: {
                profile_id: profileId,
                situation_message: situationMessage,
              },
            });
          },
        },
      },
      env: {
        isAccountSyncingEnabled: !isProduction() && isManifestV3,
      },
      messenger: this.controllerMessenger.getRestricted({
        name: 'UserStorageController',
        allowedActions: [
          'KeyringController:getState',
          'KeyringController:addNewAccount',
          'SnapController:handleRequest',
          'AuthenticationController:getBearerToken',
          'AuthenticationController:getSessionProfile',
          'AuthenticationController:isSignedIn',
          'AuthenticationController:performSignOut',
          'AuthenticationController:performSignIn',
          'AccountsController:listAccounts',
          'AccountsController:updateAccountMetadata',
          'NetworkController:getState',
          'NetworkController:addNetwork',
          'NetworkController:removeNetwork',
          'NetworkController:updateNetwork',
        ],
        allowedEvents: [
          'KeyringController:lock',
          'KeyringController:unlock',
          'AccountsController:accountAdded',
          'AccountsController:accountRenamed',
          'NetworkController:networkRemoved',
        ],
      }),
    });

    const notificationServicesPushControllerMessenger =
      this.controllerMessenger.getRestricted({
        name: 'NotificationServicesPushController',
        allowedActions: ['AuthenticationController:getBearerToken'],
        allowedEvents: [],
      });
    this.notificationServicesPushController =
      new NotificationServicesPushController.Controller({
        messenger: notificationServicesPushControllerMessenger,
        state: initState.NotificationServicesPushController,
        env: {
          apiKey: process.env.FIREBASE_API_KEY ?? '',
          authDomain: process.env.FIREBASE_AUTH_DOMAIN ?? '',
          storageBucket: process.env.FIREBASE_STORAGE_BUCKET ?? '',
          projectId: process.env.FIREBASE_PROJECT_ID ?? '',
          messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID ?? '',
          appId: process.env.FIREBASE_APP_ID ?? '',
          measurementId: process.env.FIREBASE_MEASUREMENT_ID ?? '',
          vapidKey: process.env.VAPID_KEY ?? '',
        },
        config: {
          isPushEnabled: isManifestV3,
          platform: 'extension',
          onPushNotificationReceived,
          onPushNotificationClicked,
        },
      });
    notificationServicesPushControllerMessenger.subscribe(
      'NotificationServicesPushController:onNewNotifications',
      (notification) => {
        this.metaMetricsController.trackEvent({
          category: MetaMetricsEventCategory.PushNotifications,
          event: MetaMetricsEventName.PushNotificationReceived,
          properties: {
            notification_id: notification.id,
            notification_type: notification.type,
            chain_id: notification?.chain_id,
          },
        });
      },
    );
    notificationServicesPushControllerMessenger.subscribe(
      'NotificationServicesPushController:pushNotificationClicked',
      (notification) => {
        this.metaMetricsController.trackEvent({
          category: MetaMetricsEventCategory.PushNotifications,
          event: MetaMetricsEventName.PushNotificationClicked,
          properties: {
            notification_id: notification.id,
            notification_type: notification.type,
            chain_id: notification?.chain_id,
          },
        });
      },
    );

    this.notificationServicesController =
      new NotificationServicesController.Controller({
        messenger: this.controllerMessenger.getRestricted({
          name: 'NotificationServicesController',
          allowedActions: [
            'KeyringController:getAccounts',
            'KeyringController:getState',
            'AuthenticationController:getBearerToken',
            'AuthenticationController:isSignedIn',
            'AuthenticationController:performSignIn',
            'UserStorageController:getStorageKey',
            'UserStorageController:performGetStorage',
            'UserStorageController:performSetStorage',
            'NotificationServicesPushController:enablePushNotifications',
            'NotificationServicesPushController:disablePushNotifications',
            'NotificationServicesPushController:subscribeToPushNotifications',
            'NotificationServicesPushController:updateTriggerPushNotifications',
          ],
          allowedEvents: [
            'KeyringController:stateChange',
            'KeyringController:lock',
            'KeyringController:unlock',
            'NotificationServicesPushController:onNewNotifications',
          ],
        }),
        state: initState.NotificationServicesController,
        env: {
          isPushIntegrated: isManifestV3,
          featureAnnouncements: {
            platform: 'extension',
            spaceId: process.env.CONTENTFUL_ACCESS_SPACE_ID ?? '',
            accessToken: process.env.CONTENTFUL_ACCESS_TOKEN ?? '',
          },
        },
      });

    // account tracker watches balances, nonces, and any code at their address
    this.accountTrackerController = new AccountTrackerController({
      state: { accounts: {} },
      messenger: this.controllerMessenger.getRestricted({
        name: 'AccountTrackerController',
        allowedActions: [
          'AccountsController:getSelectedAccount',
          'NetworkController:getState',
          'NetworkController:getNetworkClientById',
          'OnboardingController:getState',
          'PreferencesController:getState',
        ],
        allowedEvents: [
          'AccountsController:selectedEvmAccountChange',
          'OnboardingController:stateChange',
          'KeyringController:accountRemoved',
        ],
      }),
      provider: this.provider,
      blockTracker: this.blockTracker,
      getNetworkIdentifier: (providerConfig) => {
        const { type, rpcUrl } =
          providerConfig ??
          getProviderConfig({
            metamask: this.networkController.state,
          });
        return type === NETWORK_TYPES.RPC ? rpcUrl : type;
      },
    });

    // start and stop polling for balances based on activeControllerConnections
    this.on('controllerConnectionChanged', (activeControllerConnections) => {
      const { completedOnboarding } = this.onboardingController.state;
      if (activeControllerConnections > 0 && completedOnboarding) {
        this.triggerNetworkrequests();
      } else {
        this.stopNetworkRequests();
      }
    });

    this.controllerMessenger.subscribe(
      `${this.onboardingController.name}:stateChange`,
      previousValueComparator(async (prevState, currState) => {
        const { completedOnboarding: prevCompletedOnboarding } = prevState;
        const { completedOnboarding: currCompletedOnboarding } = currState;
        if (!prevCompletedOnboarding && currCompletedOnboarding) {
          const { address } = this.accountsController.getSelectedAccount();

          await this._addAccountsWithBalance();

          this.postOnboardingInitialization();
          this.triggerNetworkrequests();

          // execute once the token detection on the post-onboarding
          await this.tokenDetectionController.detectTokens({
            selectedAddress: address,
          });
        }
      }, this.onboardingController.state),
    );

    const tokenDetectionControllerMessenger =
      this.controllerMessenger.getRestricted({
        name: 'TokenDetectionController',
        allowedActions: [
          'AccountsController:getAccount',
          'AccountsController:getSelectedAccount',
          'KeyringController:getState',
          'NetworkController:getNetworkClientById',
          'NetworkController:getNetworkConfigurationByNetworkClientId',
          'NetworkController:getState',
          'PreferencesController:getState',
          'TokenListController:getState',
          'TokensController:getState',
          'TokensController:addDetectedTokens',
        ],
        allowedEvents: [
          'AccountsController:selectedEvmAccountChange',
          'KeyringController:lock',
          'KeyringController:unlock',
          'NetworkController:networkDidChange',
          'PreferencesController:stateChange',
          'TokenListController:stateChange',
        ],
      });

    this.tokenDetectionController = new TokenDetectionController({
      messenger: tokenDetectionControllerMessenger,
      getBalancesInSingleCall:
        this.assetsContractController.getBalancesInSingleCall.bind(
          this.assetsContractController,
        ),
      trackMetaMetricsEvent: this.metaMetricsController.trackEvent.bind(
        this.metaMetricsController,
      ),
      useAccountsAPI: true,
      platform: 'extension',
    });

    const addressBookControllerMessenger =
      this.controllerMessenger.getRestricted({
        name: 'AddressBookController',
        allowedActions: [],
        allowedEvents: [],
      });

    this.addressBookController = new AddressBookController({
      messenger: addressBookControllerMessenger,
      state: initState.AddressBookController,
    });

    this.alertController = new AlertController({
      state: initState.AlertController,
      messenger: this.controllerMessenger.getRestricted({
        name: 'AlertController',
        allowedEvents: ['AccountsController:selectedAccountChange'],
        allowedActions: ['AccountsController:getSelectedAccount'],
      }),
    });

    ///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
    this.custodyController = new CustodyController({
      initState: initState.CustodyController,
      captureException,
    });
    this.institutionalFeaturesController = new InstitutionalFeaturesController({
      initState: initState.InstitutionalFeaturesController,
      showConfirmRequest: opts.showUserConfirmation,
    });
    this.transactionUpdateController = new TransactionUpdateController({
      initState: initState.TransactionUpdateController,
      getCustodyKeyring: this.getCustodyKeyringIfExists.bind(this),
      mmiConfigurationController: this.mmiConfigurationController,
      captureException,
    });
    ///: END:ONLY_INCLUDE_IF

    this.backup = new Backup({
      preferencesController: this.preferencesController,
      addressBookController: this.addressBookController,
      accountsController: this.accountsController,
      networkController: this.networkController,
      trackMetaMetricsEvent: this.metaMetricsController.trackEvent.bind(
        this.metaMetricsController,
      ),
    });

    // This gets used as a ...spread parameter in two places: new TransactionController() and createRPCMethodTrackingMiddleware()
    this.snapAndHardwareMetricsParams = {
      getSelectedAccount: this.accountsController.getSelectedAccount.bind(
        this.accountsController,
      ),
      getAccountType: this.getAccountType.bind(this),
      getDeviceModel: this.getDeviceModel.bind(this),
      getHardwareTypeForMetric: this.getHardwareTypeForMetric.bind(this),
      snapAndHardwareMessenger: this.controllerMessenger.getRestricted({
        name: 'SnapAndHardwareMessenger',
        allowedActions: [
          'KeyringController:getKeyringForAccount',
          'SnapController:get',
          'AccountsController:getSelectedAccount',
        ],
      }),
    };

    this._addBridgeStatusControllerListeners();

    this.decryptMessageController = new DecryptMessageController({
      getState: this.getState.bind(this),
      messenger: this.controllerMessenger.getRestricted({
        name: 'DecryptMessageController',
        allowedActions: [
          `${this.approvalController.name}:addRequest`,
          `${this.approvalController.name}:acceptRequest`,
          `${this.approvalController.name}:rejectRequest`,
          `${this.keyringController.name}:decryptMessage`,
        ],
        allowedEvents: [
          'DecryptMessageManager:stateChange',
          'DecryptMessageManager:unapprovedMessage',
        ],
      }),
      managerMessenger: this.controllerMessenger.getRestricted({
        name: 'DecryptMessageManager',
      }),
      metricsEvent: this.metaMetricsController.trackEvent.bind(
        this.metaMetricsController,
      ),
    });

    this.encryptionPublicKeyController = new EncryptionPublicKeyController({
      messenger: this.controllerMessenger.getRestricted({
        name: 'EncryptionPublicKeyController',
        allowedActions: [
          `${this.approvalController.name}:addRequest`,
          `${this.approvalController.name}:acceptRequest`,
          `${this.approvalController.name}:rejectRequest`,
        ],
        allowedEvents: [
          'EncryptionPublicKeyManager:stateChange',
          'EncryptionPublicKeyManager:unapprovedMessage',
        ],
      }),
      managerMessenger: this.controllerMessenger.getRestricted({
        name: 'EncryptionPublicKeyManager',
      }),
      getEncryptionPublicKey:
        this.keyringController.getEncryptionPublicKey.bind(
          this.keyringController,
        ),
      getAccountKeyringType: this.keyringController.getAccountKeyringType.bind(
        this.keyringController,
      ),
      getState: this.getState.bind(this),
      metricsEvent: this.metaMetricsController.trackEvent.bind(
        this.metaMetricsController,
      ),
    });

    this.signatureController = new SignatureController({
      messenger: this.controllerMessenger.getRestricted({
        name: 'SignatureController',
        allowedActions: [
          `${this.approvalController.name}:addRequest`,
          `${this.keyringController.name}:signMessage`,
          `${this.keyringController.name}:signPersonalMessage`,
          `${this.keyringController.name}:signTypedMessage`,
          `${this.loggingController.name}:add`,
          `${this.networkController.name}:getNetworkClientById`,
        ],
      }),
      trace,
      decodingApiUrl: process.env.DECODING_API_URL,
      isDecodeSignatureRequestEnabled: () =>
        this.preferencesController.state.useTransactionSimulations,
    });

    this.signatureController.hub.on(
      'cancelWithReason',
      ({ metadata: message, reason }) => {
        this.metaMetricsController.trackEvent({
          event: reason,
          category: MetaMetricsEventCategory.Transactions,
          properties: {
            action: 'Sign Request',
            type: message.type,
          },
        });
      },
    );

    ///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
    const transactionMetricsRequest = this.getTransactionMetricsRequest();

    const mmiControllerMessenger = this.controllerMessenger.getRestricted({
      name: 'MMIController',
      allowedActions: [
        'AccountsController:getAccountByAddress',
        'AccountsController:setAccountName',
        'AccountsController:listAccounts',
        'AccountsController:getSelectedAccount',
        'AccountsController:setSelectedAccount',
        'MetaMetricsController:getState',
        'NetworkController:getState',
        'NetworkController:setActiveNetwork',
      ],
    });

    this.mmiController = new MMIController({
      messenger: mmiControllerMessenger,
      mmiConfigurationController: this.mmiConfigurationController,
      keyringController: this.keyringController,
      appStateController: this.appStateController,
      transactionUpdateController: this.transactionUpdateController,
      custodyController: this.custodyController,
      getState: this.getState.bind(this),
      getPendingNonce: this.getPendingNonce.bind(this),
      accountTrackerController: this.accountTrackerController,
      networkController: this.networkController,
      metaMetricsController: this.metaMetricsController,
      permissionController: this.permissionController,
      signatureController: this.signatureController,
      platform: this.platform,
      extension: this.extension,
      getTransactions: (...args) => this.txController.getTransactions(...args),
      setTxStatusSigned: (id) =>
        this.txController.updateCustodialTransaction(id, {
          status: TransactionStatus.signed,
        }),
      setTxStatusSubmitted: (id) =>
        this.txController.updateCustodialTransaction(id, {
          status: TransactionStatus.submitted,
        }),
      setTxStatusFailed: (id, reason) =>
        this.txController.updateCustodialTransaction(id, {
          status: TransactionStatus.failed,
          errorMessage: reason,
        }),
      trackTransactionEvents: handleMMITransactionUpdate.bind(
        null,
        transactionMetricsRequest,
      ),
      updateTransaction: (txMeta, note) =>
        this.txController.updateTransaction(txMeta, note),
      updateTransactionHash: (id, hash) =>
        this.txController.updateCustodialTransaction(id, { hash }),
      setChannelId: (channelId) =>
        this.institutionalFeaturesController.setChannelId(channelId),
      setConnectionRequest: (payload) =>
        this.institutionalFeaturesController.setConnectionRequest(payload),
    });
    ///: END:ONLY_INCLUDE_IF

    const swapsControllerMessenger = this.controllerMessenger.getRestricted({
      name: 'SwapsController',
      // TODO: allow these internal calls once GasFeeController and TransactionController
      // export these action types and register its action handlers
      // allowedActions: [
      //   'GasFeeController:getEIP1559GasFeeEstimates',
      //   'TransactionController:getLayer1GasFee',
      // ],
      allowedActions: [
        'NetworkController:getState',
        'NetworkController:getNetworkClientById',
        'TokenRatesController:getState',
      ],
      allowedEvents: [],
    });

    this.swapsController = new SwapsController(
      {
        messenger: swapsControllerMessenger,
        getBufferedGasLimit: async (txMeta, multiplier) => {
          const { gas: gasLimit, simulationFails } =
            await this.txController.estimateGasBuffered(
              txMeta.txParams,
              multiplier,
              this.#getGlobalNetworkClientId(),
            );

          return { gasLimit, simulationFails };
        },
        // TODO: Remove once GasFeeController exports this action type
        getEIP1559GasFeeEstimates:
          this.gasFeeController.fetchGasFeeEstimates.bind(
            this.gasFeeController,
          ),
        // TODO: Remove once TransactionController exports this action type
        getLayer1GasFee: (...args) =>
          this.txController.getLayer1GasFee(...args),
        trackMetaMetricsEvent: this.metaMetricsController.trackEvent.bind(
          this.metaMetricsController,
        ),
      },
      initState.SwapsController,
    );

    const bridgeControllerMessenger = this.controllerMessenger.getRestricted({
      name: BRIDGE_CONTROLLER_NAME,
      allowedActions: [
        'AccountsController:getSelectedAccount',
        'NetworkController:getSelectedNetworkClient',
        'NetworkController:findNetworkClientIdByChainId',
      ],
      allowedEvents: [],
    });
    this.bridgeController = new BridgeController({
      messenger: bridgeControllerMessenger,
      // TODO: Remove once TransactionController exports this action type
      getLayer1GasFee: (...args) => this.txController.getLayer1GasFee(...args),
    });

    const bridgeStatusControllerMessenger =
      this.controllerMessenger.getRestricted({
        name: BRIDGE_STATUS_CONTROLLER_NAME,
        allowedActions: [
          'AccountsController:getSelectedAccount',
          'NetworkController:getNetworkClientById',
          'NetworkController:findNetworkClientIdByChainId',
          'NetworkController:getState',
          'TransactionController:getState',
        ],
        allowedEvents: [],
      });
    this.bridgeStatusController = new BridgeStatusController({
      messenger: bridgeStatusControllerMessenger,
      state: initState.BridgeStatusController,
    });

    const smartTransactionsControllerMessenger =
      this.controllerMessenger.getRestricted({
        name: 'SmartTransactionsController',
        allowedActions: [
          'NetworkController:getNetworkClientById',
          'NetworkController:getState',
        ],
        allowedEvents: ['NetworkController:stateChange'],
      });
    this.smartTransactionsController = new SmartTransactionsController({
      supportedChainIds: getAllowedSmartTransactionsChainIds(),
      clientId: ClientId.Extension,
      getNonceLock: (address) =>
        this.txController.getNonceLock(
          address,
          this.#getGlobalNetworkClientId(),
        ),
      confirmExternalTransaction: (...args) =>
        this.txController.confirmExternalTransaction(...args),
      trackMetaMetricsEvent: this.metaMetricsController.trackEvent.bind(
        this.metaMetricsController,
      ),
      state: initState.SmartTransactionsController,
      messenger: smartTransactionsControllerMessenger,
      getTransactions: (...args) => this.txController.getTransactions(...args),
      updateTransaction: (...args) =>
        this.txController.updateTransaction(...args),
      getFeatureFlags: () => {
        const state = this._getMetaMaskState();
        return getFeatureFlagsByChainId(state);
      },
      getMetaMetricsProps: async () => {
        const selectedAddress =
          this.accountsController.getSelectedAccount().address;
        const accountHardwareType = await this.getHardwareTypeForMetric(
          selectedAddress,
        );
        const accountType = await this.getAccountType(selectedAddress);
        const deviceModel = await this.getDeviceModel(selectedAddress);
        return {
          accountHardwareType,
          accountType,
          deviceModel,
        };
      },
    });

    const isExternalNameSourcesEnabled = () =>
      this.preferencesController.state.useExternalNameSources;

    this.nameController = new NameController({
      messenger: this.controllerMessenger.getRestricted({
        name: 'NameController',
        allowedActions: [],
      }),
      providers: [
        new ENSNameProvider({
          reverseLookup: this.ensController.reverseResolveAddress.bind(
            this.ensController,
          ),
        }),
        new EtherscanNameProvider({ isEnabled: isExternalNameSourcesEnabled }),
        new TokenNameProvider({ isEnabled: isExternalNameSourcesEnabled }),
        new LensNameProvider({ isEnabled: isExternalNameSourcesEnabled }),
        new SnapsNameProvider({
          messenger: this.controllerMessenger.getRestricted({
            name: 'SnapsNameProvider',
            allowedActions: [
              'SnapController:getAll',
              'SnapController:get',
              'SnapController:handleRequest',
              'PermissionController:getState',
            ],
          }),
        }),
      ],
      state: initState.NameController,
    });

    const petnamesBridgeMessenger = this.controllerMessenger.getRestricted({
      name: 'PetnamesBridge',
      allowedEvents: [
        'NameController:stateChange',
        'AccountsController:stateChange',
        'AddressBookController:stateChange',
      ],
      allowedActions: ['AccountsController:listAccounts'],
    });

    new AddressBookPetnamesBridge({
      addressBookController: this.addressBookController,
      nameController: this.nameController,
      messenger: petnamesBridgeMessenger,
    }).init();

    new AccountIdentitiesPetnamesBridge({
      nameController: this.nameController,
      messenger: petnamesBridgeMessenger,
    }).init();

    this.userOperationController = new UserOperationController({
      entrypoint: process.env.EIP_4337_ENTRYPOINT,
      getGasFeeEstimates: this.gasFeeController.fetchGasFeeEstimates.bind(
        this.gasFeeController,
      ),
      messenger: this.controllerMessenger.getRestricted({
        name: 'UserOperationController',
        allowedActions: [
          'ApprovalController:addRequest',
          'NetworkController:getNetworkClientById',
          'KeyringController:prepareUserOperation',
          'KeyringController:patchUserOperation',
          'KeyringController:signUserOperation',
        ],
      }),
      state: initState.UserOperationController,
    });

    this.userOperationController.hub.on(
      'user-operation-added',
      this._onUserOperationAdded.bind(this),
    );

    this.userOperationController.hub.on(
      'transaction-updated',
      this._onUserOperationTransactionUpdated.bind(this),
    );

    // ensure AccountTrackerController updates balances after network change
    networkControllerMessenger.subscribe(
      'NetworkController:networkDidChange',
      () => {
        this.accountTrackerController.updateAccounts();
      },
    );

    // clear unapproved transactions and messages when the network will change
    networkControllerMessenger.subscribe(
      'NetworkController:networkWillChange',
      clearPendingConfirmations.bind(this),
    );

    // RemoteFeatureFlagController has subscription for preferences changes
    this.controllerMessenger.subscribe(
      'PreferencesController:stateChange',
      previousValueComparator((prevState, currState) => {
        const { useExternalServices: prevUseExternalServices } = prevState;
        const { useExternalServices: currUseExternalServices } = currState;
        if (currUseExternalServices && !prevUseExternalServices) {
          this.remoteFeatureFlagController.enable();
          this.remoteFeatureFlagController.updateRemoteFeatureFlags();
        } else if (!currUseExternalServices && prevUseExternalServices) {
          this.remoteFeatureFlagController.disable();
        }
      }, this.preferencesController.state),
    );

    // Initialize RemoteFeatureFlagController
    this.remoteFeatureFlagController = new RemoteFeatureFlagController({
      messenger: this.controllerMessenger.getRestricted({
        name: 'RemoteFeatureFlagController',
        allowedActions: [],
        allowedEvents: [],
      }),
      fetchInterval: 15 * 60 * 1000, // 15 minutes in milliseconds
      disabled: !this.preferencesController.state.useExternalServices,
      getMetaMetricsId: () => this.metaMetricsController.getMetaMetricsId(),
      clientConfigApiService: new ClientConfigApiService({
        fetch: globalThis.fetch.bind(globalThis),
        config: {
          client: ClientType.Extension,
          distribution:
            this._getConfigForRemoteFeatureFlagRequest().distribution,
          environment: this._getConfigForRemoteFeatureFlagRequest().environment,
        },
      }),
    });

    const existingControllers = [
      this.networkController,
      this.preferencesController,
      this.gasFeeController,
      this.onboardingController,
      this.keyringController,
      ///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
      this.transactionUpdateController,
      ///: END:ONLY_INCLUDE_IF
      this.smartTransactionsController,
    ];

    const controllerInitFunctions = {
      ExecutionService: ExecutionServiceInit,
      RateLimitController: RateLimitControllerInit,
      SnapsRegistry: SnapsRegistryInit,
      SnapController: SnapControllerInit,
      SnapInsightsController: SnapInsightsControllerInit,
      SnapInterfaceController: SnapInterfaceControllerInit,
      CronjobController: CronjobControllerInit,
      PPOMController: PPOMControllerInit,
      TransactionController: TransactionControllerInit,
      ///: BEGIN:ONLY_INCLUDE_IF(build-flask)
      MultichainAssetsController: MultichainAssetsControllerInit,
      MultiChainAssetsRatesController: MultiChainAssetsRatesControllerInit,
      MultichainBalancesController: MultichainBalancesControllerInit,
      MultichainTransactionsController: MultichainTransactionsControllerInit,
      ///: END:ONLY_INCLUDE_IF
    };

    const {
      controllerApi,
      controllerMemState,
      controllerPersistedState,
      controllersByName,
    } = this.#initControllers({
      existingControllers,
      initFunctions: controllerInitFunctions,
      initState,
    });

    this.controllerApi = controllerApi;
    this.controllerMemState = controllerMemState;
    this.controllerPersistedState = controllerPersistedState;
    this.controllersByName = controllersByName;

    // Backwards compatibility for existing references
    this.cronjobController = controllersByName.CronjobController;
    this.rateLimitController = controllersByName.RateLimitController;
    this.snapController = controllersByName.SnapController;
    this.snapInsightsController = controllersByName.SnapInsightsController;
    this.snapInterfaceController = controllersByName.SnapInterfaceController;
    this.snapsRegistry = controllersByName.SnapsRegistry;
    this.ppomController = controllersByName.PPOMController;
    this.txController = controllersByName.TransactionController;
    ///: BEGIN:ONLY_INCLUDE_IF(build-flask)
    this.multichainAssetsController =
      controllersByName.MultichainAssetsController;
    this.multichainBalancesController =
      controllersByName.MultichainBalancesController;
    this.multichainTransactionsController =
      controllersByName.MultichainTransactionsController;
    this.multiChainAssetsRatesController =
      controllersByName.MultiChainAssetsRatesController;
    ///: END:ONLY_INCLUDE_IF

    this.controllerMessenger.subscribe(
      'TransactionController:transactionStatusUpdated',
      ({ transactionMeta }) => {
        this._onFinishedTransaction(transactionMeta);
      },
    );

    this.metamaskMiddleware = createMetamaskMiddleware({
      static: {
        eth_syncing: false,
        web3_clientVersion: `MetaMask/v${version}`,
      },
      version,
      // account mgmt
      getAccounts: ({ origin: innerOrigin }) => {
        if (innerOrigin === ORIGIN_METAMASK) {
          const selectedAddress =
            this.accountsController.getSelectedAccount().address;
          return selectedAddress ? [selectedAddress] : [];
        } else if (this.isUnlocked()) {
          return this.getPermittedAccounts(innerOrigin);
        }
        return []; // changing this is a breaking change
      },
      // tx signing
      processTransaction: (transactionParams, dappRequest) =>
        addDappTransaction(
          this.getAddTransactionRequest({ transactionParams, dappRequest }),
        ),
      // msg signing
      ///: BEGIN:ONLY_INCLUDE_IF(build-main,build-beta,build-flask)

      processTypedMessage: (...args) =>
        addTypedMessage({
          signatureController: this.signatureController,
          signatureParams: args,
        }),
      processTypedMessageV3: (...args) =>
        addTypedMessage({
          signatureController: this.signatureController,
          signatureParams: args,
        }),
      processTypedMessageV4: (...args) =>
        addTypedMessage({
          signatureController: this.signatureController,
          signatureParams: args,
        }),
      processPersonalMessage: (...args) =>
        addPersonalMessage({
          signatureController: this.signatureController,
          signatureParams: args,
        }),
      ///: END:ONLY_INCLUDE_IF

      ///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
      /* eslint-disable no-dupe-keys */
      processTypedMessage: this.mmiController.newUnsignedMessage.bind(
        this.mmiController,
      ),
      processTypedMessageV3: this.mmiController.newUnsignedMessage.bind(
        this.mmiController,
      ),
      processTypedMessageV4: this.mmiController.newUnsignedMessage.bind(
        this.mmiController,
      ),
      processPersonalMessage: this.mmiController.newUnsignedMessage.bind(
        this.mmiController,
      ),
      setTypedMessageInProgress:
        this.signatureController.setTypedMessageInProgress.bind(
          this.signatureController,
        ),
      setPersonalMessageInProgress:
        this.signatureController.setPersonalMessageInProgress.bind(
          this.signatureController,
        ),
      /* eslint-enable no-dupe-keys */
      ///: END:ONLY_INCLUDE_IF

      processEncryptionPublicKey:
        this.encryptionPublicKeyController.newRequestEncryptionPublicKey.bind(
          this.encryptionPublicKeyController,
        ),

      processDecryptMessage:
        this.decryptMessageController.newRequestDecryptMessage.bind(
          this.decryptMessageController,
        ),
      getPendingNonce: this.getPendingNonce.bind(this),
      getPendingTransactionByHash: (hash) =>
        this.txController.state.transactions.find(
          (meta) =>
            meta.hash === hash && meta.status === TransactionStatus.submitted,
        ),
    });

    // ensure isClientOpenAndUnlocked is updated when memState updates
    this.on('update', (memState) => this._onStateUpdate(memState));

    /**
     * All controllers in Memstore but not in store. They are not persisted.
     * On chrome profile re-start, they will be re-initialized.
     */
    const resetOnRestartStore = {
      AccountTracker: this.accountTrackerController,
      TokenRatesController: this.tokenRatesController,
      DecryptMessageController: this.decryptMessageController,
      EncryptionPublicKeyController: this.encryptionPublicKeyController,
      SignatureController: this.signatureController,
      SwapsController: this.swapsController,
      BridgeController: this.bridgeController,
      BridgeStatusController: this.bridgeStatusController,
      EnsController: this.ensController,
      ApprovalController: this.approvalController,
    };

    this.store.updateStructure({
      AccountsController: this.accountsController,
      AppStateController: this.appStateController,
      AppMetadataController: this.appMetadataController,
      KeyringController: this.keyringController,
      PreferencesController: this.preferencesController,
      MetaMetricsController: this.metaMetricsController,
      MetaMetricsDataDeletionController: this.metaMetricsDataDeletionController,
      AddressBookController: this.addressBookController,
      CurrencyController: this.currencyRateController,
      NetworkController: this.networkController,
      AlertController: this.alertController,
      OnboardingController: this.onboardingController,
      PermissionController: this.permissionController,
      PermissionLogController: this.permissionLogController,
      SubjectMetadataController: this.subjectMetadataController,
      AnnouncementController: this.announcementController,
      NetworkOrderController: this.networkOrderController,
      AccountOrderController: this.accountOrderController,
      GasFeeController: this.gasFeeController,
      TokenListController: this.tokenListController,
      TokensController: this.tokensController,
      TokenBalancesController: this.tokenBalancesController,
      SmartTransactionsController: this.smartTransactionsController,
      NftController: this.nftController,
      PhishingController: this.phishingController,
      SelectedNetworkController: this.selectedNetworkController,
      LoggingController: this.loggingController,
      MultichainRatesController: this.multichainRatesController,
      ///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
      CustodyController: this.custodyController.store,
      InstitutionalFeaturesController:
        this.institutionalFeaturesController.store,
      MmiConfigurationController: this.mmiConfigurationController.store,
      ///: END:ONLY_INCLUDE_IF
      NameController: this.nameController,
      UserOperationController: this.userOperationController,
      // Notification Controllers
      AuthenticationController: this.authenticationController,
      UserStorageController: this.userStorageController,
      NotificationServicesController: this.notificationServicesController,
      NotificationServicesPushController:
        this.notificationServicesPushController,
      RemoteFeatureFlagController: this.remoteFeatureFlagController,
      ...resetOnRestartStore,
      ...controllerPersistedState,
    });

    this.memStore = new ComposableObservableStore({
      config: {
        AccountsController: this.accountsController,
        AppStateController: this.appStateController,
        AppMetadataController: this.appMetadataController,
        ///: BEGIN:ONLY_INCLUDE_IF(build-flask)
        MultichainAssetsController: this.multichainAssetsController,
        MultichainBalancesController: this.multichainBalancesController,
        MultichainTransactionsController: this.multichainTransactionsController,
        MultiChainAssetsRatesController: this.multiChainAssetsRatesController,
        ///: END:ONLY_INCLUDE_IF
        NetworkController: this.networkController,
        KeyringController: this.keyringController,
        PreferencesController: this.preferencesController,
        MetaMetricsController: this.metaMetricsController,
        MetaMetricsDataDeletionController:
          this.metaMetricsDataDeletionController,
        AddressBookController: this.addressBookController,
        CurrencyController: this.currencyRateController,
        AlertController: this.alertController,
        OnboardingController: this.onboardingController,
        PermissionController: this.permissionController,
        PermissionLogController: this.permissionLogController,
        SubjectMetadataController: this.subjectMetadataController,
        AnnouncementController: this.announcementController,
        NetworkOrderController: this.networkOrderController,
        AccountOrderController: this.accountOrderController,
        GasFeeController: this.gasFeeController,
        TokenListController: this.tokenListController,
        TokensController: this.tokensController,
        TokenBalancesController: this.tokenBalancesController,
        SmartTransactionsController: this.smartTransactionsController,
        NftController: this.nftController,
        SelectedNetworkController: this.selectedNetworkController,
        LoggingController: this.loggingController,
        MultichainRatesController: this.multichainRatesController,
        SnapController: this.snapController,
        CronjobController: this.cronjobController,
        SnapsRegistry: this.snapsRegistry,
        SnapInterfaceController: this.snapInterfaceController,
        SnapInsightsController: this.snapInsightsController,
        ///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
        CustodyController: this.custodyController.store,
        InstitutionalFeaturesController:
          this.institutionalFeaturesController.store,
        MmiConfigurationController: this.mmiConfigurationController.store,
        ///: END:ONLY_INCLUDE_IF
        NameController: this.nameController,
        UserOperationController: this.userOperationController,
        // Notification Controllers
        AuthenticationController: this.authenticationController,
        UserStorageController: this.userStorageController,
        NotificationServicesController: this.notificationServicesController,
        QueuedRequestController: this.queuedRequestController,
        NotificationServicesPushController:
          this.notificationServicesPushController,
        RemoteFeatureFlagController: this.remoteFeatureFlagController,
        ...resetOnRestartStore,
        ...controllerMemState,
      },
      controllerMessenger: this.controllerMessenger,
    });

    // if this is the first time, clear the state of by calling these methods
    const resetMethods = [
      this.accountTrackerController.resetState.bind(
        this.accountTrackerController,
      ),
      this.decryptMessageController.resetState.bind(
        this.decryptMessageController,
      ),
      this.encryptionPublicKeyController.resetState.bind(
        this.encryptionPublicKeyController,
      ),
      this.signatureController.resetState.bind(this.signatureController),
      this.swapsController.resetState.bind(this.swapsController),
      this.bridgeController.resetState.bind(this.bridgeController),
      this.ensController.resetState.bind(this.ensController),
      this.approvalController.clear.bind(this.approvalController),
      // WE SHOULD ADD TokenListController.resetState here too. But it's not implemented yet.
    ];

    if (isManifestV3) {
      if (isFirstMetaMaskControllerSetup === true) {
        this.resetStates(resetMethods);
        this.extension.storage.session.set({
          isFirstMetaMaskControllerSetup: false,
        });
      }
    } else {
      // it's always the first time in MV2
      this.resetStates(resetMethods);
    }

    // Automatic login via config password
    const password = process.env.PASSWORD;
    if (
      !this.isUnlocked() &&
      this.onboardingController.state.completedOnboarding &&
      password &&
      !process.env.IN_TEST
    ) {
      this._loginUser(password);
    } else {
      this._startUISync();
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
    this.setupMultichainDataAndSubscriptions();

    // For more information about these legacy streams, see here:
    // https://github.com/MetaMask/metamask-extension/issues/15491
    // TODO:LegacyProvider: Delete
    this.publicConfigStore = this.createPublicConfigStore();

    // Multiple MetaMask instances launched warning
    this.extension.runtime.onMessageExternal.addListener(onMessageReceived);
    // Fire a ping message to check if other extensions are running
    checkForMultipleVersionsRunning();

    if (this.onboardingController.state.completedOnboarding) {
      this.postOnboardingInitialization();
    }
  }

  // Provides a method for getting feature flags for the multichain
  // initial rollout, such that we can remotely modify polling interval
  getInfuraFeatureFlags() {
    fetchWithCache({
      url: 'https://swap.api.cx.metamask.io/featureFlags',
      cacheRefreshTime: MINUTE * 20,
    })
      .then(this.onFeatureFlagResponseReceived)
      .catch((e) => {
        // API unreachable (?)
        log.warn('Feature flag endpoint is unreachable', e);
      });
  }

  onFeatureFlagResponseReceived(response) {
    const { multiChainAssets = {} } = response;
    const { pollInterval } = multiChainAssets;
    // Polling interval is provided in seconds
    if (pollInterval > 0) {
      this.tokenBalancesController.setIntervalLength(pollInterval * SECOND);
    }
  }

  postOnboardingInitialization() {
    const { usePhishDetect } = this.preferencesController.state;

    this.networkController.lookupNetwork();

    if (usePhishDetect) {
      this.phishingController.maybeUpdateState();
    }

    // post onboarding emit detectTokens event
    const preferencesControllerState = this.preferencesController.state;
    const { useTokenDetection, useNftDetection } =
      preferencesControllerState ?? {};
    this.metaMetricsController.trackEvent({
      category: MetaMetricsEventCategory.Onboarding,
      event: MetaMetricsUserTrait.TokenDetectionEnabled,
      properties: {
        [MetaMetricsUserTrait.TokenDetectionEnabled]: useTokenDetection,
      },
    });
    this.metaMetricsController.trackEvent({
      category: MetaMetricsEventCategory.Onboarding,
      event: MetaMetricsUserTrait.NftAutodetectionEnabled,
      properties: {
        [MetaMetricsUserTrait.NftAutodetectionEnabled]: useNftDetection,
      },
    });
  }

  triggerNetworkrequests() {
    this.txController.stopIncomingTransactionPolling();

    this.txController.startIncomingTransactionPolling([
      this.#getGlobalChainId(),
    ]);

    this.tokenDetectionController.enable();
    this.getInfuraFeatureFlags();
  }

  stopNetworkRequests() {
    this.txController.stopIncomingTransactionPolling();
    this.tokenDetectionController.disable();
  }

  resetStates(resetMethods) {
    resetMethods.forEach((resetMethod) => {
      try {
        resetMethod();
      } catch (err) {
        console.error(err);
      }
    });
  }

  ///: BEGIN:ONLY_INCLUDE_IF(keyring-snaps)
  /**
   * Initialize the snap keyring if it is not present.
   *
   * @returns {SnapKeyring}
   */
  async getSnapKeyring() {
    let [snapKeyring] = this.keyringController.getKeyringsByType(
      KeyringType.snap,
    );
    if (!snapKeyring) {
      snapKeyring = await this.keyringController.addNewKeyring(
        KeyringType.snap,
      );
    }
    return snapKeyring;
  }
  ///: END:ONLY_INCLUDE_IF

  trackInsightSnapView(snapId) {
    this.metaMetricsController.trackEvent({
      event: MetaMetricsEventName.InsightSnapViewed,
      category: MetaMetricsEventCategory.Snaps,
      properties: {
        snap_id: snapId,
      },
    });
  }

  /**
   * Get snap metadata from the current state without refreshing the registry database.
   *
   * @param {string} snapId - A snap id.
   * @returns The available metadata for the snap, if any.
   */
  _getSnapMetadata(snapId) {
    return this.snapsRegistry.state.database?.verifiedSnaps?.[snapId]?.metadata;
  }

  /**
   * Tracks snaps export usage.
   * Note: This function is throttled to 1 call per 60 seconds per snap id + handler combination.
   *
   * @param {string} snapId - The ID of the snap the handler is being triggered on.
   * @param {string} handler - The handler to trigger on the snap for the request.
   * @param {boolean} success - Whether the invocation was successful or not.
   * @param {string} origin - The origin of the request.
   */
  _trackSnapExportUsage = wrap(
    memoize(
      () =>
        throttle(
          (snapId, handler, success, origin) =>
            this.metaMetricsController.trackEvent({
              event: MetaMetricsEventName.SnapExportUsed,
              category: MetaMetricsEventCategory.Snaps,
              properties: {
                snap_id: snapId,
                export: handler,
                snap_category: this._getSnapMetadata(snapId)?.category,
                success,
                origin,
              },
            }),
          SECOND * 60,
        ),
      (snapId, handler, _, origin) => `${snapId}${handler}${origin}`,
    ),
    (getFunc, ...args) => getFunc(...args)(...args),
  );

  /**
   * Passes a JSON-RPC request object to the SnapController for execution.
   *
   * @param {object} args - A bag of options.
   * @param {string} args.snapId - The ID of the recipient snap.
   * @param {string} args.origin - The origin of the RPC request.
   * @param {string} args.handler - The handler to trigger on the snap for the request.
   * @param {object} args.request - The JSON-RPC request object.
   * @returns The result of the JSON-RPC request.
   */
  async handleSnapRequest(args) {
    try {
      const response = await this.controllerMessenger.call(
        'SnapController:handleRequest',
        args,
      );
      this._trackSnapExportUsage(args.snapId, args.handler, true, args.origin);
      return response;
    } catch (error) {
      this._trackSnapExportUsage(args.snapId, args.handler, false, args.origin);
      throw error;
    }
  }

  /**
   * Gets the currently selected locale from the PreferencesController.
   *
   * @returns The currently selected locale.
   */
  getLocale() {
    const { currentLocale } = this.preferencesController.state;

    return currentLocale;
  }

  /**
   * Gets whether the privacy mode is enabled from the PreferencesController.
   *
   * @returns {boolean} Whether the privacy mode is enabled.
   */
  getPrivacyMode() {
    const { privacyMode } = this.preferencesController.state;

    return privacyMode;
  }

  /**
   * Constructor helper for getting Snap permission specifications.
   */
  getSnapPermissionSpecifications() {
    return {
      ...buildSnapEndowmentSpecifications(Object.keys(ExcludedSnapEndowments)),
      ...buildSnapRestrictedMethodSpecifications(
        Object.keys(ExcludedSnapPermissions),
        {
          getPreferences: () => {
            const locale = this.getLocale();
            const currency = this.currencyRateController.state.currentCurrency;
            const hideBalances = this.getPrivacyMode();
            return { locale, currency, hideBalances };
          },
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
          handleSnapRpcRequest: this.handleSnapRequest.bind(this),
          getSnapState: this.controllerMessenger.call.bind(
            this.controllerMessenger,
            'SnapController:getSnapState',
          ),
          requestUserApproval:
            this.approvalController.addAndShowApprovalRequest.bind(
              this.approvalController,
            ),
          showNativeNotification: (origin, args) =>
            this.controllerMessenger.call(
              'RateLimitController:call',
              origin,
              'showNativeNotification',
              origin,
              args.message,
            ),
          showInAppNotification: (origin, args) => {
            const { message, title, footerLink } = args;
            const notificationArgs = {
              interfaceId: args.content,
              message,
              title,
              footerLink,
            };
            return this.controllerMessenger.call(
              'RateLimitController:call',
              origin,
              'showInAppNotification',
              origin,
              notificationArgs,
            );
          },
          updateSnapState: this.controllerMessenger.call.bind(
            this.controllerMessenger,
            'SnapController:updateSnapState',
          ),
          maybeUpdatePhishingList: () => {
            const { usePhishDetect } = this.preferencesController.state;

            if (!usePhishDetect) {
              return;
            }

            this.controllerMessenger.call(
              'PhishingController:maybeUpdateState',
            );
          },
          isOnPhishingList: (url) => {
            const { usePhishDetect } = this.preferencesController.state;

            if (!usePhishDetect) {
              return false;
            }

            return this.controllerMessenger.call(
              'PhishingController:testOrigin',
              url,
            ).result;
          },
          createInterface: this.controllerMessenger.call.bind(
            this.controllerMessenger,
            'SnapInterfaceController:createInterface',
          ),
          getInterface: this.controllerMessenger.call.bind(
            this.controllerMessenger,
            'SnapInterfaceController:getInterface',
          ),
          // We don't currently use special cryptography for the extension client.
          getClientCryptography: () => ({}),
          ///: BEGIN:ONLY_INCLUDE_IF(keyring-snaps)
          getSnapKeyring: this.getSnapKeyring.bind(this),
          ///: END:ONLY_INCLUDE_IF
        },
      ),
    };
  }

  /**
   * Sets up BaseController V2 event subscriptions. Currently, this includes
   * the subscriptions necessary to notify permission subjects of account
   * changes.
   *
   * Some of the subscriptions in this method are Messenger selector
   * event subscriptions. See the relevant documentation for
   * `@metamask/base-controller` for more information.
   *
   * Note that account-related notifications emitted when the extension
   * becomes unlocked are handled in MetaMaskController._onUnlock.
   */
  setupControllerEventSubscriptions() {
    let lastSelectedAddress;
    this.controllerMessenger.subscribe(
      'PreferencesController:stateChange',
      previousValueComparator(async (prevState, currState) => {
        const { currentLocale } = currState;
        const chainId = this.#getGlobalChainId();

        await updateCurrentLocale(currentLocale);

        if (currState.incomingTransactionsPreferences?.[chainId]) {
          this.txController.stopIncomingTransactionPolling();

          this.txController.startIncomingTransactionPolling([
            this.#getGlobalChainId(),
          ]);
        } else {
          this.txController.stopIncomingTransactionPolling();
        }

        this.#checkTokenListPolling(currState, prevState);
      }, this.preferencesController.state),
    );

    this.controllerMessenger.subscribe(
      `${this.accountsController.name}:selectedAccountChange`,
      async (account) => {
        if (account.address && account.address !== lastSelectedAddress) {
          lastSelectedAddress = account.address;
          await this._onAccountChange(account.address);
        }
      },
    );

    // This handles account changes every time relevant permission state
    // changes, for any reason.
    this.controllerMessenger.subscribe(
      `${this.permissionController.name}:stateChange`,
      async (currentValue, previousValue) => {
        const changedAccounts = diffMap(currentValue, previousValue);

        for (const [origin, accounts] of changedAccounts.entries()) {
          this._notifyAccountsChange(origin, accounts);
        }
      },
      getPermittedAccountsByOrigin,
    );

    this.controllerMessenger.subscribe(
      `${this.permissionController.name}:stateChange`,
      async (currentValue, previousValue) => {
        const changedChains = diffMap(currentValue, previousValue);

        // This operates under the assumption that there will be at maximum
        // one origin permittedChains value change per event handler call
        for (const [origin, chains] of changedChains.entries()) {
          const currentNetworkClientIdForOrigin =
            this.selectedNetworkController.getNetworkClientIdForDomain(origin);
          const { chainId: currentChainIdForOrigin } =
            this.networkController.getNetworkConfigurationByNetworkClientId(
              currentNetworkClientIdForOrigin,
            );
          // if(chains.length === 0) {
          // TODO: This particular case should also occur at the same time
          // that eth_accounts is revoked. When eth_accounts is revoked,
          // the networkClientId for that origin should be reset to track
          // the globally selected network.
          // }
          if (chains.length > 0 && !chains.includes(currentChainIdForOrigin)) {
            const networkClientId =
              this.networkController.findNetworkClientIdByChainId(chains[0]);
            this.networkController.setActiveNetwork(networkClientId);
            this.selectedNetworkController.setNetworkClientIdForDomain(
              origin,
              networkClientId,
            );
          }
        }
      },
      getPermittedChainsByOrigin,
    );

    this.controllerMessenger.subscribe(
      'NetworkController:networkRemoved',
      ({ chainId }) => {
        this.removeAllChainIdPermissions(chainId);
      },
    );

    this.controllerMessenger.subscribe(
      'NetworkController:networkDidChange',
      async () => {
        await this.txController.stopIncomingTransactionPolling();

        await this.txController.updateIncomingTransactions([
          this.#getGlobalChainId(),
        ]);

        await this.txController.startIncomingTransactionPolling([
          this.#getGlobalChainId(),
        ]);
      },
    );

    this.controllerMessenger.subscribe(
      `${this.snapController.name}:snapInstallStarted`,
      (snapId, origin, isUpdate) => {
        const snapCategory = this._getSnapMetadata(snapId)?.category;
        this.metaMetricsController.trackEvent({
          event: isUpdate
            ? MetaMetricsEventName.SnapUpdateStarted
            : MetaMetricsEventName.SnapInstallStarted,
          category: MetaMetricsEventCategory.Snaps,
          properties: {
            snap_id: snapId,
            origin,
            snap_category: snapCategory,
          },
        });
      },
    );

    this.controllerMessenger.subscribe(
      `${this.snapController.name}:snapInstallFailed`,
      (snapId, origin, isUpdate, error) => {
        const isRejected = error.includes('User rejected the request.');
        const failedEvent = isUpdate
          ? MetaMetricsEventName.SnapUpdateFailed
          : MetaMetricsEventName.SnapInstallFailed;
        const rejectedEvent = isUpdate
          ? MetaMetricsEventName.SnapUpdateRejected
          : MetaMetricsEventName.SnapInstallRejected;

        const snapCategory = this._getSnapMetadata(snapId)?.category;
        this.metaMetricsController.trackEvent({
          event: isRejected ? rejectedEvent : failedEvent,
          category: MetaMetricsEventCategory.Snaps,
          properties: {
            snap_id: snapId,
            origin,
            snap_category: snapCategory,
          },
        });
      },
    );

    this.controllerMessenger.subscribe(
      `${this.snapController.name}:snapInstalled`,
      (truncatedSnap, origin, preinstalled) => {
        if (preinstalled) {
          return;
        }

        const snapId = truncatedSnap.id;
        const snapCategory = this._getSnapMetadata(snapId)?.category;
        this.metaMetricsController.trackEvent({
          event: MetaMetricsEventName.SnapInstalled,
          category: MetaMetricsEventCategory.Snaps,
          properties: {
            snap_id: snapId,
            version: truncatedSnap.version,
            origin,
            snap_category: snapCategory,
          },
        });
      },
    );

    this.controllerMessenger.subscribe(
      `${this.snapController.name}:snapUpdated`,
      (newSnap, oldVersion, origin, preinstalled) => {
        if (preinstalled) {
          return;
        }

        const snapId = newSnap.id;
        const snapCategory = this._getSnapMetadata(snapId)?.category;
        this.metaMetricsController.trackEvent({
          event: MetaMetricsEventName.SnapUpdated,
          category: MetaMetricsEventCategory.Snaps,
          properties: {
            snap_id: snapId,
            old_version: oldVersion,
            new_version: newSnap.version,
            origin,
            snap_category: snapCategory,
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
            approval.type.startsWith(RestrictedMethods.snap_dialog),
        );
        for (const approval of approvals) {
          this.approvalController.reject(
            approval.id,
            new Error('Snap was terminated.'),
          );
        }
      },
    );

    this.controllerMessenger.subscribe(
      `${this.snapController.name}:snapUninstalled`,
      (truncatedSnap) => {
        const notificationIds = this.notificationServicesController
          .getNotificationsByType(TRIGGER_TYPES.SNAP)
          .filter(
            (notification) => notification.data.origin === truncatedSnap.id,
          )
          .map((notification) => notification.id);

        this.notificationServicesController.deleteNotificationsById(
          notificationIds,
        );

        const snapId = truncatedSnap.id;
        const snapCategory = this._getSnapMetadata(snapId)?.category;
        this.metaMetricsController.trackEvent({
          event: MetaMetricsEventName.SnapUninstalled,
          category: MetaMetricsEventCategory.Snaps,
          properties: {
            snap_id: snapId,
            version: truncatedSnap.version,
            snap_category: snapCategory,
          },
        });
      },
    );
  }

  /**
   * Sets up multichain data and subscriptions.
   * This method is called during the MetaMaskController constructor.
   * It starts the MultichainRatesController if selected account is non-EVM
   * and subscribes to account changes.
   */
  setupMultichainDataAndSubscriptions() {
    if (
      !isEvmAccountType(
        this.accountsController.getSelectedMultichainAccount().type,
      )
    ) {
      this.multichainRatesController.start();
    }

    this.controllerMessenger.subscribe(
      'AccountsController:selectedAccountChange',
      (selectedAccount) => {
        if (isEvmAccountType(selectedAccount.type)) {
          this.multichainRatesController.stop();
          return;
        }
        this.multichainRatesController.start();
      },
    );

    this.controllerMessenger.subscribe(
      'CurrencyRateController:stateChange',
      ({ currentCurrency }) => {
        if (
          currentCurrency !== this.multichainRatesController.state.fiatCurrency
        ) {
          this.multichainRatesController.setFiatCurrency(currentCurrency);
        }
      },
    );
  }

  /**
   * TODO:LegacyProvider: Delete
   * Constructor helper: initialize a public config store.
   * This store is used to make some config info available to Dapps synchronously.
   */
  createPublicConfigStore() {
    // subset of state for metamask inpage provider
    const publicConfigStore = new ObservableStore();

    const selectPublicState = async ({ isUnlocked }) => {
      const { chainId, networkVersion, isConnected } =
        await this.getProviderNetworkState();

      return {
        isUnlocked,
        chainId,
        networkVersion: isConnected ? networkVersion : 'loading',
      };
    };

    const updatePublicConfigStore = async (memState) => {
      const networkStatus =
        memState.networksMetadata[memState.selectedNetworkClientId]?.status;
      if (networkStatus === NetworkStatus.Available) {
        publicConfigStore.putState(await selectPublicState(memState));
      }
    };

    // setup memStore subscription hooks
    this.on('update', updatePublicConfigStore);
    updatePublicConfigStore(this.getState());

    return publicConfigStore;
  }

  /**
   * Gets relevant state for the provider of an external origin.
   *
   * @param {string} origin - The origin to get the provider state for.
   * @returns {Promise<{ isUnlocked: boolean, networkVersion: string, chainId: string, accounts: string[] }>} An object with relevant state properties.
   */
  async getProviderState(origin) {
    const providerNetworkState = await this.getProviderNetworkState(origin);

    return {
      isUnlocked: this.isUnlocked(),
      accounts: this.getPermittedAccounts(origin),
      ...providerNetworkState,
    };
  }

  /**
   * Retrieves network state information relevant for external providers.
   *
   * @param {string} origin - The origin identifier for which network state is requested (default: 'metamask').
   * @returns {object} An object containing important network state properties, including chainId and networkVersion.
   */
  async getProviderNetworkState(origin = METAMASK_DOMAIN) {
    const networkClientId = this.controllerMessenger.call(
      'SelectedNetworkController:getNetworkClientIdForDomain',
      origin,
    );

    const networkClient = this.controllerMessenger.call(
      'NetworkController:getNetworkClientById',
      networkClientId,
    );

    const { chainId } = networkClient.configuration;

    const { completedOnboarding } = this.onboardingController.state;

    let networkVersion = this.deprecatedNetworkVersions[networkClientId];
    if (networkVersion === undefined && completedOnboarding) {
      try {
        const result = await networkClient.provider.request({
          method: 'net_version',
        });
        networkVersion = convertNetworkId(result);
      } catch (error) {
        console.error(error);
        networkVersion = null;
      }

      this.deprecatedNetworkVersions[networkClientId] = networkVersion;
    }

    const metadata =
      this.networkController.state.networksMetadata[networkClientId];

    return {
      chainId,
      networkVersion: networkVersion ?? 'loading',
      isConnected: metadata?.status === NetworkStatus.Available,
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
    const { vault } = this.keyringController.state;
    const isInitialized = Boolean(vault);
    const flatState = this.memStore.getFlatState();

    return {
      isInitialized,
      ...sanitizeUIState(flatState),
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
      accountsController,
      addressBookController,
      alertController,
      appStateController,
      keyringController,
      nftController,
      nftDetectionController,
      currencyRateController,
      tokenBalancesController,
      tokenDetectionController,
      ensController,
      tokenListController,
      gasFeeController,
      metaMetricsController,
      networkController,
      announcementController,
      onboardingController,
      permissionController,
      preferencesController,
      tokensController,
      smartTransactionsController,
      txController,
      assetsContractController,
      backup,
      approvalController,
      phishingController,
      tokenRatesController,
      accountTrackerController,
      // Notification Controllers
      authenticationController,
      userStorageController,
      notificationServicesController,
      notificationServicesPushController,
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
      setUsePhishDetect: preferencesController.setUsePhishDetect.bind(
        preferencesController,
      ),
      setUseMultiAccountBalanceChecker:
        preferencesController.setUseMultiAccountBalanceChecker.bind(
          preferencesController,
        ),
      setUseSafeChainsListValidation:
        preferencesController.setUseSafeChainsListValidation.bind(
          preferencesController,
        ),
      setUseTokenDetection: preferencesController.setUseTokenDetection.bind(
        preferencesController,
      ),
      setUseNftDetection: preferencesController.setUseNftDetection.bind(
        preferencesController,
      ),
      setUse4ByteResolution: preferencesController.setUse4ByteResolution.bind(
        preferencesController,
      ),
      setUseCurrencyRateCheck:
        preferencesController.setUseCurrencyRateCheck.bind(
          preferencesController,
        ),
      setOpenSeaEnabled: preferencesController.setOpenSeaEnabled.bind(
        preferencesController,
      ),
      getProviderConfig: () =>
        getProviderConfig({
          metamask: this.networkController.state,
        }),
      grantPermissionsIncremental:
        this.permissionController.grantPermissionsIncremental.bind(
          this.permissionController,
        ),
      grantPermissions: this.permissionController.grantPermissions.bind(
        this.permissionController,
      ),
      setSecurityAlertsEnabled:
        preferencesController.setSecurityAlertsEnabled.bind(
          preferencesController,
        ),
      ///: BEGIN:ONLY_INCLUDE_IF(keyring-snaps)
      setAddSnapAccountEnabled:
        preferencesController.setAddSnapAccountEnabled.bind(
          preferencesController,
        ),
      ///: END:ONLY_INCLUDE_IF
      ///: BEGIN:ONLY_INCLUDE_IF(build-flask)
      setWatchEthereumAccountEnabled:
        preferencesController.setWatchEthereumAccountEnabled.bind(
          preferencesController,
        ),
      ///: END:ONLY_INCLUDE_IF
      ///: BEGIN:ONLY_INCLUDE_IF(solana)
      setSolanaSupportEnabled:
        preferencesController.setSolanaSupportEnabled.bind(
          preferencesController,
        ),
      ///: END:ONLY_INCLUDE_IF
      setBitcoinSupportEnabled:
        preferencesController.setBitcoinSupportEnabled.bind(
          preferencesController,
        ),
      setBitcoinTestnetSupportEnabled:
        preferencesController.setBitcoinTestnetSupportEnabled.bind(
          preferencesController,
        ),
      setUseExternalNameSources:
        preferencesController.setUseExternalNameSources.bind(
          preferencesController,
        ),
      setUseTransactionSimulations:
        preferencesController.setUseTransactionSimulations.bind(
          preferencesController,
        ),
      setIpfsGateway: preferencesController.setIpfsGateway.bind(
        preferencesController,
      ),
      setIsIpfsGatewayEnabled:
        preferencesController.setIsIpfsGatewayEnabled.bind(
          preferencesController,
        ),
      setUseAddressBarEnsResolution:
        preferencesController.setUseAddressBarEnsResolution.bind(
          preferencesController,
        ),
      setParticipateInMetaMetrics:
        metaMetricsController.setParticipateInMetaMetrics.bind(
          metaMetricsController,
        ),
      setDataCollectionForMarketing:
        metaMetricsController.setDataCollectionForMarketing.bind(
          metaMetricsController,
        ),
      setMarketingCampaignCookieId:
        metaMetricsController.setMarketingCampaignCookieId.bind(
          metaMetricsController,
        ),
      setCurrentLocale: preferencesController.setCurrentLocale.bind(
        preferencesController,
      ),
      setIncomingTransactionsPreferences:
        preferencesController.setIncomingTransactionsPreferences.bind(
          preferencesController,
        ),
      setServiceWorkerKeepAlivePreference:
        preferencesController.setServiceWorkerKeepAlivePreference.bind(
          preferencesController,
        ),
      markPasswordForgotten: this.markPasswordForgotten.bind(this),
      unMarkPasswordForgotten: this.unMarkPasswordForgotten.bind(this),
      getRequestAccountTabIds: this.getRequestAccountTabIds,
      getOpenMetamaskTabsIds: this.getOpenMetamaskTabsIds,
      markNotificationPopupAsAutomaticallyClosed: () =>
        this.notificationManager.markAsAutomaticallyClosed(),

      // primary keyring management
      addNewAccount: this.addNewAccount.bind(this),
      getSeedPhrase: this.getSeedPhrase.bind(this),
      resetAccount: this.resetAccount.bind(this),
      removeAccount: this.removeAccount.bind(this),
      importAccountWithStrategy: this.importAccountWithStrategy.bind(this),
      getNextAvailableAccountName:
        accountsController.getNextAvailableAccountName.bind(accountsController),
      ///: BEGIN:ONLY_INCLUDE_IF(keyring-snaps)
      getAccountsBySnapId: (snapId) => getAccountsBySnapId(this, snapId),
      ///: END:ONLY_INCLUDE_IF

      // hardware wallets
      connectHardware: this.connectHardware.bind(this),
      forgetDevice: this.forgetDevice.bind(this),
      checkHardwareStatus: this.checkHardwareStatus.bind(this),
      unlockHardwareWalletAccount: this.unlockHardwareWalletAccount.bind(this),
      attemptLedgerTransportCreation:
        this.attemptLedgerTransportCreation.bind(this),

      // qr hardware devices
      submitQRHardwareCryptoHDKey:
        keyringController.submitQRCryptoHDKey.bind(keyringController),
      submitQRHardwareCryptoAccount:
        keyringController.submitQRCryptoAccount.bind(keyringController),
      cancelSyncQRHardware:
        keyringController.cancelQRSynchronization.bind(keyringController),
      submitQRHardwareSignature:
        keyringController.submitQRSignature.bind(keyringController),
      cancelQRHardwareSignRequest:
        keyringController.cancelQRSignRequest.bind(keyringController),

      // vault management
      submitPassword: this.submitPassword.bind(this),
      verifyPassword: this.verifyPassword.bind(this),

      // network management
      setActiveNetwork: (networkConfigurationId) => {
        return this.networkController.setActiveNetwork(networkConfigurationId);
      },
      // Avoids returning the promise so that initial call to switch network
      // doesn't block on the network lookup step
      setActiveNetworkConfigurationId: (networkConfigurationId) => {
        this.networkController.setActiveNetwork(networkConfigurationId);
      },
      setNetworkClientIdForDomain: (origin, networkClientId) => {
        return this.selectedNetworkController.setNetworkClientIdForDomain(
          origin,
          networkClientId,
        );
      },
      rollbackToPreviousProvider:
        networkController.rollbackToPreviousProvider.bind(networkController),
      addNetwork: this.networkController.addNetwork.bind(
        this.networkController,
      ),
      updateNetwork: this.networkController.updateNetwork.bind(
        this.networkController,
      ),
      removeNetwork: this.networkController.removeNetwork.bind(
        this.networkController,
      ),
      getCurrentNetworkEIP1559Compatibility:
        this.networkController.getEIP1559Compatibility.bind(
          this.networkController,
        ),
      getNetworkConfigurationByNetworkClientId:
        this.networkController.getNetworkConfigurationByNetworkClientId.bind(
          this.networkController,
        ),
      // PreferencesController
      setSelectedAddress: (address) => {
        const account = this.accountsController.getAccountByAddress(address);
        if (account) {
          this.accountsController.setSelectedAccount(account.id);
        } else {
          throw new Error(`No account found for address: ${address}`);
        }
      },
      toggleExternalServices: this.toggleExternalServices.bind(this),
      addToken: tokensController.addToken.bind(tokensController),
      updateTokenType: tokensController.updateTokenType.bind(tokensController),
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
      setOverrideContentSecurityPolicyHeader:
        preferencesController.setOverrideContentSecurityPolicyHeader.bind(
          preferencesController,
        ),
      setAdvancedGasFee: preferencesController.setAdvancedGasFee.bind(
        preferencesController,
      ),
      setTheme: preferencesController.setTheme.bind(preferencesController),
      ///: BEGIN:ONLY_INCLUDE_IF(keyring-snaps)
      setSnapsAddSnapAccountModalDismissed:
        preferencesController.setSnapsAddSnapAccountModalDismissed.bind(
          preferencesController,
        ),
      ///: END:ONLY_INCLUDE_IF

      // AccountsController
      setSelectedInternalAccount: (id) => {
        const account = this.accountsController.getAccount(id);
        if (account) {
          this.accountsController.setSelectedAccount(id);
        }
      },

      setAccountName:
        accountsController.setAccountName.bind(accountsController),

      setAccountLabel: (address, label) => {
        const account = this.accountsController.getAccountByAddress(address);
        if (account === undefined) {
          throw new Error(`No account found for address: ${address}`);
        }
        this.accountsController.setAccountName(account.id, label);
      },

      // AssetsContractController
      getTokenStandardAndDetails: this.getTokenStandardAndDetails.bind(this),
      getTokenSymbol: this.getTokenSymbol.bind(this),

      // NftController
      addNft: nftController.addNft.bind(nftController),

      addNftVerifyOwnership:
        nftController.addNftVerifyOwnership.bind(nftController),

      removeAndIgnoreNft: nftController.removeAndIgnoreNft.bind(nftController),

      removeNft: nftController.removeNft.bind(nftController),

      checkAndUpdateAllNftsOwnershipStatus:
        nftController.checkAndUpdateAllNftsOwnershipStatus.bind(nftController),

      checkAndUpdateSingleNftOwnershipStatus:
        nftController.checkAndUpdateSingleNftOwnershipStatus.bind(
          nftController,
        ),

      getNFTContractInfo: nftController.getNFTContractInfo.bind(nftController),

      isNftOwner: nftController.isNftOwner.bind(nftController),

      // AddressController
      setAddressBook: addressBookController.set.bind(addressBookController),
      removeFromAddressBook: addressBookController.delete.bind(
        addressBookController,
      ),

      // AppStateController
      setLastActiveTime:
        appStateController.setLastActiveTime.bind(appStateController),
      setCurrentExtensionPopupId:
        appStateController.setCurrentExtensionPopupId.bind(appStateController),
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
      setTermsOfUseLastAgreed:
        appStateController.setTermsOfUseLastAgreed.bind(appStateController),
      setSurveyLinkLastClickedOrClosed:
        appStateController.setSurveyLinkLastClickedOrClosed.bind(
          appStateController,
        ),
      setOnboardingDate:
        appStateController.setOnboardingDate.bind(appStateController),
      setLastViewedUserSurvey:
        appStateController.setLastViewedUserSurvey.bind(appStateController),
      setRampCardClosed:
        appStateController.setRampCardClosed.bind(appStateController),
      setNewPrivacyPolicyToastClickedOrClosed:
        appStateController.setNewPrivacyPolicyToastClickedOrClosed.bind(
          appStateController,
        ),
      setNewPrivacyPolicyToastShownDate:
        appStateController.setNewPrivacyPolicyToastShownDate.bind(
          appStateController,
        ),
      setSnapsInstallPrivacyWarningShownStatus:
        appStateController.setSnapsInstallPrivacyWarningShownStatus.bind(
          appStateController,
        ),
      setOutdatedBrowserWarningLastShown:
        appStateController.setOutdatedBrowserWarningLastShown.bind(
          appStateController,
        ),
      setShowTestnetMessageInDropdown:
        appStateController.setShowTestnetMessageInDropdown.bind(
          appStateController,
        ),
      setShowBetaHeader:
        appStateController.setShowBetaHeader.bind(appStateController),
      setShowPermissionsTour:
        appStateController.setShowPermissionsTour.bind(appStateController),
      setShowAccountBanner:
        appStateController.setShowAccountBanner.bind(appStateController),
      setShowNetworkBanner:
        appStateController.setShowNetworkBanner.bind(appStateController),
      updateNftDropDownState:
        appStateController.updateNftDropDownState.bind(appStateController),
      setSwitchedNetworkDetails:
        appStateController.setSwitchedNetworkDetails.bind(appStateController),
      clearSwitchedNetworkDetails:
        appStateController.clearSwitchedNetworkDetails.bind(appStateController),
      setSwitchedNetworkNeverShowMessage:
        appStateController.setSwitchedNetworkNeverShowMessage.bind(
          appStateController,
        ),
      getLastInteractedConfirmationInfo:
        appStateController.getLastInteractedConfirmationInfo.bind(
          appStateController,
        ),
      setLastInteractedConfirmationInfo:
        appStateController.setLastInteractedConfirmationInfo.bind(
          appStateController,
        ),
      updateSlides: appStateController.updateSlides.bind(appStateController),
      removeSlide: appStateController.removeSlide.bind(appStateController),

      // EnsController
      tryReverseResolveAddress:
        ensController.reverseResolveAddress.bind(ensController),

      // KeyringController
      setLocked: this.setLocked.bind(this),
      createNewVaultAndKeychain: this.createNewVaultAndKeychain.bind(this),
      createNewVaultAndRestore: this.createNewVaultAndRestore.bind(this),
      exportAccount: this.exportAccount.bind(this),

      // txController
      updateTransaction: txController.updateTransaction.bind(txController),
      approveTransactionsWithSameNonce:
        txController.approveTransactionsWithSameNonce.bind(txController),
      createCancelTransaction: this.createCancelTransaction.bind(this),
      createSpeedUpTransaction: this.createSpeedUpTransaction.bind(this),
      estimateGas: this.estimateGas.bind(this),
      estimateGasFee: txController.estimateGasFee.bind(txController),
      getNextNonce: this.getNextNonce.bind(this),
      addTransaction: (transactionParams, transactionOptions) =>
        addTransaction(
          this.getAddTransactionRequest({
            transactionParams,
            transactionOptions,
            waitForSubmit: false,
          }),
        ),
      addTransactionAndWaitForPublish: (
        transactionParams,
        transactionOptions,
      ) =>
        addTransaction(
          this.getAddTransactionRequest({
            transactionParams,
            transactionOptions,
            waitForSubmit: true,
          }),
        ),
      createTransactionEventFragment:
        createTransactionEventFragmentWithTxId.bind(
          null,
          this.getTransactionMetricsRequest(),
        ),

      // decryptMessageController
      decryptMessage: this.decryptMessageController.decryptMessage.bind(
        this.decryptMessageController,
      ),
      decryptMessageInline:
        this.decryptMessageController.decryptMessageInline.bind(
          this.decryptMessageController,
        ),
      cancelDecryptMessage:
        this.decryptMessageController.cancelDecryptMessage.bind(
          this.decryptMessageController,
        ),

      // EncryptionPublicKeyController
      encryptionPublicKey:
        this.encryptionPublicKeyController.encryptionPublicKey.bind(
          this.encryptionPublicKeyController,
        ),
      cancelEncryptionPublicKey:
        this.encryptionPublicKeyController.cancelEncryptionPublicKey.bind(
          this.encryptionPublicKeyController,
        ),

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

      // permissions
      removePermissionsFor: this.removePermissionsFor,
      approvePermissionsRequest: this.acceptPermissionsRequest,
      rejectPermissionsRequest: this.rejectPermissionsRequest,
      ...getPermissionBackgroundApiMethods({
        permissionController,
        approvalController,
      }),

      ///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
      connectCustodyAddresses: this.mmiController.connectCustodyAddresses.bind(
        this.mmiController,
      ),
      getCustodianAccounts: this.mmiController.getCustodianAccounts.bind(
        this.mmiController,
      ),
      getCustodianTransactionDeepLink:
        this.mmiController.getCustodianTransactionDeepLink.bind(
          this.mmiController,
        ),
      getCustodianConfirmDeepLink:
        this.mmiController.getCustodianConfirmDeepLink.bind(this.mmiController),
      getCustodianSignMessageDeepLink:
        this.mmiController.getCustodianSignMessageDeepLink.bind(
          this.mmiController,
        ),
      getCustodianToken: this.mmiController.getCustodianToken.bind(
        this.mmiController,
      ),
      getCustodianJWTList: this.mmiController.getCustodianJWTList.bind(
        this.mmiController,
      ),
      getAllCustodianAccountsWithToken:
        this.mmiController.getAllCustodianAccountsWithToken.bind(
          this.mmiController,
        ),
      setCustodianNewRefreshToken:
        this.mmiController.setCustodianNewRefreshToken.bind(this.mmiController),
      setWaitForConfirmDeepLinkDialog:
        this.custodyController.setWaitForConfirmDeepLinkDialog.bind(
          this.custodyController,
        ),
      getMmiConfiguration:
        this.mmiConfigurationController.getConfiguration.bind(
          this.mmiConfigurationController,
        ),
      removeAddTokenConnectRequest:
        this.institutionalFeaturesController.removeAddTokenConnectRequest.bind(
          this.institutionalFeaturesController,
        ),
      setConnectionRequest:
        this.institutionalFeaturesController.setConnectionRequest.bind(
          this.institutionalFeaturesController,
        ),
      showInteractiveReplacementTokenBanner:
        appStateController.showInteractiveReplacementTokenBanner.bind(
          appStateController,
        ),
      setCustodianDeepLink:
        appStateController.setCustodianDeepLink.bind(appStateController),
      setNoteToTraderMessage:
        appStateController.setNoteToTraderMessage.bind(appStateController),
      logAndStoreApiRequest: this.mmiController.logAndStoreApiRequest.bind(
        this.mmiController,
      ),
      ///: END:ONLY_INCLUDE_IF

      // snaps
      disableSnap: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SnapController:disable',
      ),
      enableSnap: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SnapController:enable',
      ),
      updateSnap: (origin, requestedSnaps) => {
        // We deliberately do not await this promise as that would mean waiting for the update to complete
        // Instead we return null to signal to the UI that it is safe to redirect to the update flow
        this.controllerMessenger.call(
          'SnapController:install',
          origin,
          requestedSnaps,
        );
        return null;
      },
      removeSnap: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SnapController:remove',
      ),
      handleSnapRequest: this.handleSnapRequest.bind(this),
      revokeDynamicSnapPermissions: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SnapController:revokeDynamicPermissions',
      ),
      disconnectOriginFromSnap: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SnapController:disconnectOrigin',
      ),
      updateNetworksList: this.updateNetworksList.bind(this),
      updateAccountsList: this.updateAccountsList.bind(this),
      updateHiddenAccountsList: this.updateHiddenAccountsList.bind(this),
      getPhishingResult: async (website) => {
        await phishingController.maybeUpdateState();

        return phishingController.test(website);
      },
      deleteInterface: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SnapInterfaceController:deleteInterface',
      ),
      updateInterfaceState: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SnapInterfaceController:updateInterfaceState',
      ),

      // swaps
      fetchAndSetQuotes: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:fetchAndSetQuotes',
      ),
      setSelectedQuoteAggId: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:setSelectedQuoteAggId',
      ),
      resetSwapsState: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:resetSwapsState',
      ),
      setSwapsTokens: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:setSwapsTokens',
      ),
      clearSwapsQuotes: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:clearSwapsQuotes',
      ),
      setApproveTxId: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:setApproveTxId',
      ),
      setTradeTxId: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:setTradeTxId',
      ),
      setSwapsTxGasPrice: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:setSwapsTxGasPrice',
      ),
      setSwapsTxGasLimit: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:setSwapsTxGasLimit',
      ),
      setSwapsTxMaxFeePerGas: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:setSwapsTxMaxFeePerGas',
      ),
      setSwapsTxMaxFeePriorityPerGas: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:setSwapsTxMaxFeePriorityPerGas',
      ),
      safeRefetchQuotes: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:safeRefetchQuotes',
      ),
      stopPollingForQuotes: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:stopPollingForQuotes',
      ),
      setBackgroundSwapRouteState: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:setBackgroundSwapRouteState',
      ),
      resetPostFetchState: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:resetPostFetchState',
      ),
      setSwapsErrorKey: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:setSwapsErrorKey',
      ),
      setInitialGasEstimate: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:setInitialGasEstimate',
      ),
      setCustomApproveTxData: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:setCustomApproveTxData',
      ),
      setSwapsLiveness: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:setSwapsLiveness',
      ),
      setSwapsFeatureFlags: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:setSwapsFeatureFlags',
      ),
      setSwapsUserFeeLevel: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:setSwapsUserFeeLevel',
      ),
      setSwapsQuotesPollingLimitEnabled: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        'SwapsController:setSwapsQuotesPollingLimitEnabled',
      ),

      // Bridge
      [BridgeBackgroundAction.SET_FEATURE_FLAGS]:
        this.controllerMessenger.call.bind(
          this.controllerMessenger,
          `${BRIDGE_CONTROLLER_NAME}:${BridgeBackgroundAction.SET_FEATURE_FLAGS}`,
        ),
      [BridgeBackgroundAction.RESET_STATE]: this.controllerMessenger.call.bind(
        this.controllerMessenger,
        `${BRIDGE_CONTROLLER_NAME}:${BridgeBackgroundAction.RESET_STATE}`,
      ),
      [BridgeBackgroundAction.GET_BRIDGE_ERC20_ALLOWANCE]:
        this.controllerMessenger.call.bind(
          this.controllerMessenger,
          `${BRIDGE_CONTROLLER_NAME}:${BridgeBackgroundAction.GET_BRIDGE_ERC20_ALLOWANCE}`,
        ),
      [BridgeUserAction.UPDATE_QUOTE_PARAMS]:
        this.controllerMessenger.call.bind(
          this.controllerMessenger,
          `${BRIDGE_CONTROLLER_NAME}:${BridgeUserAction.UPDATE_QUOTE_PARAMS}`,
        ),

      // Bridge Status
      [BridgeStatusAction.START_POLLING_FOR_BRIDGE_TX_STATUS]:
        this.controllerMessenger.call.bind(
          this.controllerMessenger,
          `${BRIDGE_STATUS_CONTROLLER_NAME}:${BridgeStatusAction.START_POLLING_FOR_BRIDGE_TX_STATUS}`,
        ),

      // Smart Transactions
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
      trackInsightSnapView: this.trackInsightSnapView.bind(this),

      // ApprovalController
      rejectAllPendingApprovals: this.rejectAllPendingApprovals.bind(this),
      rejectPendingApproval: this.rejectPendingApproval,
      requestUserApproval:
        approvalController.addAndShowApprovalRequest.bind(approvalController),
      resolvePendingApproval: this.resolvePendingApproval,

      // Notifications
      resetViewedNotifications: announcementController.resetViewed.bind(
        announcementController,
      ),
      updateViewedNotifications: announcementController.updateViewed.bind(
        announcementController,
      ),

      // CurrencyRateController
      currencyRateStartPolling: currencyRateController.startPolling.bind(
        currencyRateController,
      ),
      currencyRateStopPollingByPollingToken:
        currencyRateController.stopPollingByPollingToken.bind(
          currencyRateController,
        ),

      tokenRatesStartPolling:
        tokenRatesController.startPolling.bind(tokenRatesController),
      tokenRatesStopPollingByPollingToken:
        tokenRatesController.stopPollingByPollingToken.bind(
          tokenRatesController,
        ),
      accountTrackerStartPolling:
        accountTrackerController.startPollingByNetworkClientId.bind(
          accountTrackerController,
        ),
      accountTrackerStopPollingByPollingToken:
        accountTrackerController.stopPollingByPollingToken.bind(
          accountTrackerController,
        ),

      tokenDetectionStartPolling: tokenDetectionController.startPolling.bind(
        tokenDetectionController,
      ),
      tokenDetectionStopPollingByPollingToken:
        tokenDetectionController.stopPollingByPollingToken.bind(
          tokenDetectionController,
        ),

      tokenListStartPolling:
        tokenListController.startPolling.bind(tokenListController),
      tokenListStopPollingByPollingToken:
        tokenListController.stopPollingByPollingToken.bind(tokenListController),

      tokenBalancesStartPolling: tokenBalancesController.startPolling.bind(
        tokenBalancesController,
      ),
      tokenBalancesStopPollingByPollingToken:
        tokenBalancesController.stopPollingByPollingToken.bind(
          tokenBalancesController,
        ),

      // GasFeeController
      gasFeeStartPolling: gasFeeController.startPolling.bind(gasFeeController),
      gasFeeStopPollingByPollingToken:
        gasFeeController.stopPollingByPollingToken.bind(gasFeeController),

      getGasFeeTimeEstimate:
        gasFeeController.getTimeEstimate.bind(gasFeeController),

      addPollingTokenToAppState:
        appStateController.addPollingToken.bind(appStateController),

      removePollingTokenFromAppState:
        appStateController.removePollingToken.bind(appStateController),

      updateThrottledOriginState:
        appStateController.updateThrottledOriginState.bind(appStateController),

      // Backup
      backupUserData: backup.backupUserData.bind(backup),
      restoreUserData: backup.restoreUserData.bind(backup),

      // TokenDetectionController
      detectTokens: tokenDetectionController.detectTokens.bind(
        tokenDetectionController,
      ),

      // DetectCollectibleController
      detectNfts: nftDetectionController.detectNfts.bind(
        nftDetectionController,
      ),

      /** Token Detection V2 */
      addDetectedTokens:
        tokensController.addDetectedTokens.bind(tokensController),
      addImportedTokens: tokensController.addTokens.bind(tokensController),
      ignoreTokens: tokensController.ignoreTokens.bind(tokensController),
      getBalancesInSingleCall:
        assetsContractController.getBalancesInSingleCall.bind(
          assetsContractController,
        ),

      // Authentication Controller
      performSignIn: authenticationController.performSignIn.bind(
        authenticationController,
      ),
      performSignOut: authenticationController.performSignOut.bind(
        authenticationController,
      ),

      // UserStorageController
      enableProfileSyncing: userStorageController.enableProfileSyncing.bind(
        userStorageController,
      ),
      disableProfileSyncing: userStorageController.disableProfileSyncing.bind(
        userStorageController,
      ),
      syncInternalAccountsWithUserStorage:
        userStorageController.syncInternalAccountsWithUserStorage.bind(
          userStorageController,
        ),
      deleteAccountSyncingDataFromUserStorage:
        userStorageController.performDeleteStorageAllFeatureEntries.bind(
          userStorageController,
        ),

      // NotificationServicesController
      checkAccountsPresence:
        notificationServicesController.checkAccountsPresence.bind(
          notificationServicesController,
        ),
      createOnChainTriggers:
        notificationServicesController.createOnChainTriggers.bind(
          notificationServicesController,
        ),
      deleteOnChainTriggersByAccount:
        notificationServicesController.deleteOnChainTriggersByAccount.bind(
          notificationServicesController,
        ),
      updateOnChainTriggersByAccount:
        notificationServicesController.updateOnChainTriggersByAccount.bind(
          notificationServicesController,
        ),
      fetchAndUpdateMetamaskNotifications:
        notificationServicesController.fetchAndUpdateMetamaskNotifications.bind(
          notificationServicesController,
        ),
      deleteNotificationsById:
        notificationServicesController.deleteNotificationsById.bind(
          notificationServicesController,
        ),
      getNotificationsByType:
        notificationServicesController.getNotificationsByType.bind(
          notificationServicesController,
        ),
      markMetamaskNotificationsAsRead:
        notificationServicesController.markMetamaskNotificationsAsRead.bind(
          notificationServicesController,
        ),
      setFeatureAnnouncementsEnabled:
        notificationServicesController.setFeatureAnnouncementsEnabled.bind(
          notificationServicesController,
        ),
      enablePushNotifications:
        notificationServicesPushController.enablePushNotifications.bind(
          notificationServicesPushController,
        ),
      disablePushNotifications:
        notificationServicesPushController.disablePushNotifications.bind(
          notificationServicesPushController,
        ),
      updateTriggerPushNotifications:
        notificationServicesPushController.updateTriggerPushNotifications.bind(
          notificationServicesPushController,
        ),
      enableMetamaskNotifications:
        notificationServicesController.enableMetamaskNotifications.bind(
          notificationServicesController,
        ),
      disableMetamaskNotifications:
        notificationServicesController.disableNotificationServices.bind(
          notificationServicesController,
        ),

      // E2E testing
      throwTestError: this.throwTestError.bind(this),

      // NameController
      updateProposedNames: this.nameController.updateProposedNames.bind(
        this.nameController,
      ),
      setName: this.nameController.setName.bind(this.nameController),

      ///: BEGIN:ONLY_INCLUDE_IF(build-flask)
      // MultichainBalancesController
      multichainUpdateBalance: (accountId) =>
        this.multichainBalancesController.updateBalance(accountId),

      // MultichainTransactionsController
      multichainUpdateTransactions: (accountId) =>
        this.multichainTransactionsController.updateTransactionsForAccount(
          accountId,
        ),
      ///: END:ONLY_INCLUDE_IF
      // Transaction Decode
      decodeTransactionData: (request) =>
        decodeTransactionData({
          ...request,
          provider: this.provider,
        }),
      // metrics data deleteion
      createMetaMetricsDataDeletionTask:
        this.metaMetricsDataDeletionController.createMetaMetricsDataDeletionTask.bind(
          this.metaMetricsDataDeletionController,
        ),
      updateDataDeletionTaskStatus:
        this.metaMetricsDataDeletionController.updateDataDeletionTaskStatus.bind(
          this.metaMetricsDataDeletionController,
        ),
      // Trace
      endTrace,
    };
  }

  async exportAccount(address, password) {
    await this.verifyPassword(password);
    return this.keyringController.exportAccount(password, address);
  }

  async getTokenStandardAndDetails(address, userAddress, tokenId) {
    const { tokenList } = this.tokenListController.state;
    const { tokens } = this.tokensController.state;

    const staticTokenListDetails =
      STATIC_MAINNET_TOKEN_LIST[address?.toLowerCase()] || {};
    const tokenListDetails = tokenList[address.toLowerCase()] || {};
    const userDefinedTokenDetails =
      tokens.find(({ address: _address }) =>
        isEqualCaseInsensitive(_address, address),
      ) || {};

    const tokenDetails = {
      ...staticTokenListDetails,
      ...tokenListDetails,
      ...userDefinedTokenDetails,
    };

    const tokenDetailsStandardIsERC20 =
      isEqualCaseInsensitive(tokenDetails.standard, TokenStandard.ERC20) ||
      tokenDetails.erc20 === true;

    const noEvidenceThatTokenIsAnNFT =
      !tokenId &&
      !isEqualCaseInsensitive(tokenDetails.standard, TokenStandard.ERC1155) &&
      !isEqualCaseInsensitive(tokenDetails.standard, TokenStandard.ERC721) &&
      !tokenDetails.erc721;

    const otherDetailsAreERC20Like =
      tokenDetails.decimals !== undefined && tokenDetails.symbol;

    const tokenCanBeTreatedAsAnERC20 =
      tokenDetailsStandardIsERC20 ||
      (noEvidenceThatTokenIsAnNFT && otherDetailsAreERC20Like);

    let details;
    if (tokenCanBeTreatedAsAnERC20) {
      try {
        const balance = userAddress
          ? await fetchTokenBalance(address, userAddress, this.provider)
          : undefined;

        details = {
          address,
          balance,
          standard: TokenStandard.ERC20,
          decimals: tokenDetails.decimals,
          symbol: tokenDetails.symbol,
        };
      } catch (e) {
        // If the `fetchTokenBalance` call failed, `details` remains undefined, and we
        // fall back to the below `assetsContractController.getTokenStandardAndDetails` call
        log.warn(`Failed to get token balance. Error: ${e}`);
      }
    }

    // `details`` will be undefined if `tokenCanBeTreatedAsAnERC20`` is false,
    // or if it is true but the `fetchTokenBalance`` call failed. In either case, we should
    // attempt to retrieve details from `assetsContractController.getTokenStandardAndDetails`
    if (details === undefined) {
      try {
        details =
          await this.assetsContractController.getTokenStandardAndDetails(
            address,
            userAddress,
            tokenId,
          );
      } catch (e) {
        log.warn(`Failed to get token standard and details. Error: ${e}`);
      }
    }

    if (details) {
      const tokenDetailsStandardIsERC1155 = isEqualCaseInsensitive(
        details.standard,
        TokenStandard.ERC1155,
      );

      if (tokenDetailsStandardIsERC1155) {
        try {
          const balance = await fetchERC1155Balance(
            address,
            userAddress,
            tokenId,
            this.provider,
          );

          const balanceToUse = balance?._hex
            ? parseInt(balance._hex, 16).toString()
            : null;

          details = {
            ...details,
            balance: balanceToUse,
          };
        } catch (e) {
          // If the `fetchTokenBalance` call failed, `details` remains undefined, and we
          // fall back to the below `assetsContractController.getTokenStandardAndDetails` call
          log.warn('Failed to get token balance. Error:', e);
        }
      }
    }

    return {
      ...details,
      decimals: details?.decimals?.toString(10),
      balance: details?.balance?.toString(10),
    };
  }

  async getTokenSymbol(address) {
    try {
      const details =
        await this.assetsContractController.getTokenStandardAndDetails(address);
      return details?.symbol;
    } catch (e) {
      return null;
    }
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
      return await this.keyringController.createNewVaultAndKeychain(password);
    } finally {
      releaseLock();
    }
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
      const { completedOnboarding } = this.onboardingController.state;

      const seedPhraseAsBuffer = Buffer.from(encodedSeedPhrase);

      // clear permissions
      this.permissionController.clearState();

      // Clear snap state
      this.snapController.clearState();

      // clear accounts in AccountTrackerController
      this.accountTrackerController.clearAccounts();

      this.txController.clearUnapprovedTransactions();

      if (completedOnboarding) {
        this.tokenDetectionController.enable();
      }

      // create new vault
      await this.keyringController.createNewVaultAndRestore(
        password,
        this._convertMnemonicToWordlistIndices(seedPhraseAsBuffer),
      );

      if (completedOnboarding) {
        await this._addAccountsWithBalance();

        // This must be set as soon as possible to communicate to the
        // keyring's iframe and have the setting initialized properly
        // Optimistically called to not block MetaMask login due to
        // Ledger Keyring GitHub downtime
        this.#withKeyringForDevice(
          { name: HardwareDeviceNames.ledger },
          async (keyring) => this.setLedgerTransportPreference(keyring),
        );
      }
    } finally {
      releaseLock();
    }
  }

  async _addAccountsWithBalance() {
    try {
      // Scan accounts until we find an empty one
      const chainId = this.#getGlobalChainId();
      const accounts = await this.keyringController.getAccounts();
      let address = accounts[accounts.length - 1];

      for (let count = accounts.length; ; count++) {
        const balance = await this.getBalance(address, this.provider);

        if (balance === '0x0') {
          // This account has no balance, so check for tokens
          await this.tokenDetectionController.detectTokens({
            chainIds: [chainId],
            selectedAddress: address,
          });

          const tokens =
            this.tokensController.state.allTokens?.[chainId]?.[address];
          const detectedTokens =
            this.tokensController.state.allDetectedTokens?.[chainId]?.[address];

          if (
            (tokens?.length ?? 0) === 0 &&
            (detectedTokens?.length ?? 0) === 0
          ) {
            // This account has no balance or tokens
            if (count !== 1) {
              await this.removeAccount(address);
            }
            break;
          }
        }

        // This account has assets, so check the next one
        address = await this.keyringController.addNewAccount(count);
      }
    } catch (e) {
      log.warn(`Failed to add accounts with balance. Error: ${e}`);
    } finally {
      await this.userStorageController.setIsAccountSyncingReadyToBeDispatched(
        true,
      );
    }
  }

  /**
   * Encodes a BIP-39 mnemonic as the indices of words in the English BIP-39 wordlist.
   *
   * @param {Buffer} mnemonic - The BIP-39 mnemonic.
   * @returns {Buffer} The Unicode code points for the seed phrase formed from the words in the wordlist.
   */
  _convertMnemonicToWordlistIndices(mnemonic) {
    const indices = mnemonic
      .toString()
      .split(' ')
      .map((word) => wordlist.indexOf(word));
    return new Uint8Array(new Uint16Array(indices).buffer);
  }

  /**
   * Converts a BIP-39 mnemonic stored as indices of words in the English wordlist to a buffer of Unicode code points.
   *
   * @param {Uint8Array} wordlistIndices - Indices to specific words in the BIP-39 English wordlist.
   * @returns {Buffer} The BIP-39 mnemonic formed from the words in the English wordlist, encoded as a list of Unicode code points.
   */
  _convertEnglishWordlistIndicesToCodepoints(wordlistIndices) {
    return Buffer.from(
      Array.from(new Uint16Array(wordlistIndices.buffer))
        .map((i) => wordlist[i])
        .join(' '),
    );
  }

  /**
   * Get an account balance from the AccountTrackerController or request it directly from the network.
   *
   * @param {string} address - The account address
   * @param {Provider} provider - The provider instance to use when asking the network
   */
  async getBalance(address, provider) {
    const cached = this.accountTrackerController.state.accounts[address];

    if (cached && cached.balance) {
      return cached.balance;
    }

    try {
      const balance = await provider.request({
        method: 'eth_getBalance',
        params: [address, 'latest'],
      });
      return balance || '0x0';
    } catch (error) {
      log.error(error);
      throw error;
    }
  }

  /**
   * Submits the user's password and attempts to unlock the vault.
   * Also synchronizes the preferencesController, to ensure its schema
   * is up to date with known accounts once the vault is decrypted.
   *
   * @param {string} password - The user's password
   */
  async submitPassword(password) {
    const { completedOnboarding } = this.onboardingController.state;

    // Before attempting to unlock the keyrings, we need the offscreen to have loaded.
    await this.offscreenPromise;

    await this.keyringController.submitPassword(password);

    ///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
    this.mmiController.onSubmitPassword();
    ///: END:ONLY_INCLUDE_IF

    try {
      await this.blockTracker.checkForLatestBlock();
    } catch (error) {
      log.error('Error while unlocking extension.', error);
    }

    await this.accountsController.updateAccounts();

    // This must be set as soon as possible to communicate to the
    // keyring's iframe and have the setting initialized properly
    // Optimistically called to not block MetaMask login due to
    // Ledger Keyring GitHub downtime
    if (completedOnboarding) {
      this.#withKeyringForDevice(
        { name: HardwareDeviceNames.ledger },
        async (keyring) => this.setLedgerTransportPreference(keyring),
      );
    }
  }

  async _loginUser(password) {
    try {
      // Automatic login via config password
      await this.submitPassword(password);

      // Updating accounts in this.accountTrackerController before starting UI syncing ensure that
      // state has account balance before it is synced with UI
      await this.accountTrackerController.updateAccountsAllActiveNetworks();
    } finally {
      this._startUISync();
    }
  }

  _startUISync() {
    // Message startUISync is used to start syncing state with UI
    // Sending this message after login is completed helps to ensure that incomplete state without
    // account details are not flushed to UI.
    this.emit('startUISync');
    this.startUISync = true;
    this.memStore.subscribe(this.sendUpdate.bind(this));
  }

  /**
   * Submits a user's encryption key to log the user in via login token
   */
  async submitEncryptionKey() {
    try {
      const { loginToken, loginSalt } =
        await this.extension.storage.session.get(['loginToken', 'loginSalt']);
      if (loginToken && loginSalt) {
        const { vault } = this.keyringController.state;

        const jsonVault = JSON.parse(vault);

        if (jsonVault.salt !== loginSalt) {
          console.warn(
            'submitEncryptionKey: Stored salt and vault salt do not match',
          );
          await this.clearLoginArtifacts();
          return;
        }

        await this.keyringController.submitEncryptionKey(loginToken, loginSalt);
      }
    } catch (e) {
      // If somehow this login token doesn't work properly,
      // remove it and the user will get shown back to the unlock screen
      await this.clearLoginArtifacts();
      throw e;
    }
  }

  async clearLoginArtifacts() {
    await this.extension.storage.session.remove(['loginToken', 'loginSalt']);
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
   * @type Identity
   * @property {string} name - The account nickname.
   * @property {string} address - The account's ethereum address, in lower case.
   * receiving funds from our automatic Ropsten faucet.
   */

  /**
   * Gets the mnemonic of the user's primary keyring.
   */
  getPrimaryKeyringMnemonic() {
    const [keyring] = this.keyringController.getKeyringsByType(
      KeyringType.hdKeyTree,
    );
    if (!keyring.mnemonic) {
      throw new Error('Primary keyring mnemonic unavailable.');
    }

    return keyring.mnemonic;
  }

  ///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
  async getCustodyKeyringIfExists(address) {
    const custodyType = this.custodyController.getCustodyTypeByAddress(
      toChecksumHexAddress(address),
    );
    const keyring = this.keyringController.getKeyringsByType(custodyType)[0];
    return keyring?.getAccountDetails(address) ? keyring : undefined;
  }
  ///: END:ONLY_INCLUDE_IF

  //
  // Hardware
  //

  async attemptLedgerTransportCreation() {
    return await this.#withKeyringForDevice(
      { name: HardwareDeviceNames.ledger },
      async (keyring) => keyring.attemptMakeApp(),
    );
  }

  /**
   * Fetch account list from a hardware device.
   *
   * @param deviceName
   * @param page
   * @param hdPath
   * @returns [] accounts
   */
  async connectHardware(deviceName, page, hdPath) {
    return this.#withKeyringForDevice(
      { name: deviceName, hdPath },
      async (keyring) => {
        if (deviceName === HardwareDeviceNames.ledger) {
          await this.setLedgerTransportPreference(keyring);
        }

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
        this.accountTrackerController.syncWithAddresses(accountsToTrack);
        return accounts;
      },
    );
  }

  /**
   * Check if the device is unlocked
   *
   * @param deviceName
   * @param hdPath
   * @returns {Promise<boolean>}
   */
  async checkHardwareStatus(deviceName, hdPath) {
    return this.#withKeyringForDevice(
      { name: deviceName, hdPath },
      async (keyring) => {
        return keyring.isUnlocked();
      },
    );
  }

  /**
   * Get hardware type that will be sent for metrics logging.
   *
   * @param {string} address - Address to retrieve the keyring from
   * @returns {HardwareKeyringType} Keyring hardware type
   */
  async getHardwareTypeForMetric(address) {
    // The `getKeyringForAccount` is now deprecated, so we just use `withKeyring` instead to access our keyring.
    return await this.keyringController.withKeyring(
      { address },
      ({ type: keyringType, bridge: keyringBridge }) =>
        // Specific case for OneKey devices, see `ONE_KEY_VIA_TREZOR_MINOR_VERSION` for further details.
        keyringBridge?.minorVersion === ONE_KEY_VIA_TREZOR_MINOR_VERSION
          ? HardwareKeyringType.oneKey
          : HardwareKeyringType[keyringType],
    );
  }

  /**
   * Clear
   *
   * @param deviceName
   * @returns {Promise<boolean>}
   */
  async forgetDevice(deviceName) {
    return this.#withKeyringForDevice({ name: deviceName }, async (keyring) => {
      for (const address of keyring.accounts) {
        this._onAccountRemoved(address);
      }

      keyring.forgetDevice();

      return true;
    });
  }

  /**
   * Retrieves the keyring for the selected address and using the .type returns
   * a subtype for the account. Either 'hardware', 'imported', 'snap', or 'MetaMask'.
   *
   * @param {string} address - Address to retrieve keyring for
   * @returns {'hardware' | 'imported' | 'snap' | 'MetaMask'}
   */
  async getAccountType(address) {
    const keyringType = await this.keyringController.getAccountKeyringType(
      address,
    );
    switch (keyringType) {
      case KeyringType.trezor:
      case KeyringType.oneKey:
      case KeyringType.lattice:
      case KeyringType.qr:
      case KeyringType.ledger:
        return 'hardware';
      case KeyringType.imported:
        return 'imported';
      case KeyringType.snap:
        return 'snap';
      default:
        return 'MetaMask';
    }
  }

  /**
   * Retrieves the keyring for the selected address and using the .type
   * determines if a more specific name for the device is available. Returns
   * undefined for non hardware wallets.
   *
   * @param {string} address - Address to retrieve keyring for
   * @returns {'ledger' | 'lattice' | string | undefined}
   */
  async getDeviceModel(address) {
    return this.keyringController.withKeyring({ address }, async (keyring) => {
      switch (keyring.type) {
        case KeyringType.trezor:
        case KeyringType.oneKey:
          return keyring.getModel();
        case KeyringType.qr:
          return keyring.getName();
        case KeyringType.ledger:
          // TODO: get model after ledger keyring exposes method
          return HardwareDeviceNames.ledger;
        case KeyringType.lattice:
          // TODO: get model after lattice keyring exposes method
          return HardwareDeviceNames.lattice;
        default:
          return undefined;
      }
    });
  }

  /**
   * get hardware account label
   *
   * @param name
   * @param index
   * @param hdPathDescription
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
    const { address: unlockedAccount, label } =
      await this.#withKeyringForDevice(
        { name: deviceName, hdPath },
        async (keyring) => {
          keyring.setAccountToUnlock(index);
          const [address] = await keyring.addAccounts(1);
          return {
            address: normalize(address),
            label: this.getAccountLabel(
              deviceName === HardwareDeviceNames.qr
                ? keyring.getName()
                : deviceName,
              index,
              hdPathDescription,
            ),
          };
        },
      );

    // Set the account label to Trezor 1 / Ledger 1 / QR Hardware 1, etc
    this.preferencesController.setAccountLabel(unlockedAccount, label);
    // Select the account
    this.preferencesController.setSelectedAddress(unlockedAccount);

    // It is expected that the account also exist in the accounts-controller
    // in other case, an error shall be thrown
    const account =
      this.accountsController.getAccountByAddress(unlockedAccount);
    this.accountsController.setAccountName(account.id, label);

    const accounts = this.accountsController.listAccounts();

    const { identities } = this.preferencesController.state;
    return { unlockedAccount, identities, accounts };
  }

  //
  // Account Management
  //

  /**
   * Adds a new account to the default (first) HD seed phrase Keyring.
   *
   * @param accountCount
   * @returns {Promise<string>} The address of the newly-created account.
   */
  async addNewAccount(accountCount) {
    const oldAccounts = await this.keyringController.getAccounts();

    const addedAccountAddress = await this.keyringController.addNewAccount(
      accountCount,
    );

    if (!oldAccounts.includes(addedAccountAddress)) {
      this.preferencesController.setSelectedAddress(addedAccountAddress);
    }

    return addedAccountAddress;
  }

  /**
   * Verifies the validity of the current vault's seed phrase.
   *
   * Validity: seed phrase restores the accounts belonging to the current vault.
   *
   * Called when the first account is created and on unlocking the vault.
   *
   * @param password
   * @returns {Promise<number[]>} The seed phrase to be confirmed by the user,
   * encoded as an array of UTF-8 bytes.
   */
  async getSeedPhrase(password) {
    return this._convertEnglishWordlistIndicesToCodepoints(
      await this.keyringController.exportSeedPhrase(password),
    );
  }

  /**
   * Clears the transaction history, to allow users to force-reset their nonces.
   * Mostly used in development environments, when networks are restarted with
   * the same network ID.
   *
   * @returns {Promise<string>} The current selected address.
   */
  async resetAccount() {
    const selectedAddress =
      this.accountsController.getSelectedAccount().address;

    const globalChainId = this.#getGlobalChainId();

    this.txController.wipeTransactions({
      address: selectedAddress,
      chainId: globalChainId,
    });

    this.smartTransactionsController.wipeSmartTransactions({
      address: selectedAddress,
      ignoreNetwork: false,
    });

    this.bridgeStatusController.wipeBridgeStatus({
      address: selectedAddress,
      ignoreNetwork: false,
    });

    this.networkController.resetConnection();

    return selectedAddress;
  }

  /**
   * Checks that all accounts referenced have a matching InternalAccount. Sends
   * an error to sentry for any accounts that were expected but are missing from the wallet.
   *
   * @param {InternalAccount[]} [internalAccounts] - The list of evm accounts the wallet knows about.
   * @param {Hex[]} [accounts] - The list of evm accounts addresses that should exist.
   */
  captureKeyringTypesWithMissingIdentities(
    internalAccounts = [],
    accounts = [],
  ) {
    const accountsMissingIdentities = accounts.filter(
      (address) =>
        !internalAccounts.some(
          (account) => account.address.toLowerCase() === address.toLowerCase(),
        ),
    );
    const keyringTypesWithMissingIdentities = accountsMissingIdentities.map(
      (address) => this.keyringController.getAccountKeyringType(address),
    );

    const internalAccountCount = internalAccounts.length;

    const accountTrackerCount = Object.keys(
      this.accountTrackerController.state.accounts || {},
    ).length;

    captureException(
      new Error(
        `Attempt to get permission specifications failed because their were ${accounts.length} accounts, but ${internalAccountCount} identities, and the ${keyringTypesWithMissingIdentities} keyrings included accounts with missing identities. Meanwhile, there are ${accountTrackerCount} accounts in the account tracker.`,
      ),
    );
  }

  /**
   * Sorts a list of evm account addresses by most recently selected by using
   * the lastSelected value for the matching InternalAccount object stored in state.
   *
   * @param {Hex[]} [accounts] - The list of evm accounts addresses to sort.
   * @returns {Hex[]} The sorted evm accounts addresses.
   */
  sortAccountsByLastSelected(accounts) {
    const internalAccounts = this.accountsController.listAccounts();

    return accounts.sort((firstAddress, secondAddress) => {
      const firstAccount = internalAccounts.find(
        (internalAccount) =>
          internalAccount.address.toLowerCase() === firstAddress.toLowerCase(),
      );

      const secondAccount = internalAccounts.find(
        (internalAccount) =>
          internalAccount.address.toLowerCase() === secondAddress.toLowerCase(),
      );

      if (!firstAccount) {
        this.captureKeyringTypesWithMissingIdentities(
          internalAccounts,
          accounts,
        );
        throw new Error(`Missing identity for address: "${firstAddress}".`);
      } else if (!secondAccount) {
        this.captureKeyringTypesWithMissingIdentities(
          internalAccounts,
          accounts,
        );
        throw new Error(`Missing identity for address: "${secondAddress}".`);
      } else if (
        firstAccount.metadata.lastSelected ===
        secondAccount.metadata.lastSelected
      ) {
        return 0;
      } else if (firstAccount.metadata.lastSelected === undefined) {
        return 1;
      } else if (secondAccount.metadata.lastSelected === undefined) {
        return -1;
      }

      return (
        secondAccount.metadata.lastSelected - firstAccount.metadata.lastSelected
      );
    });
  }

  /**
   * Gets the sorted permitted accounts for the specified origin. Returns an empty
   * array if no accounts are permitted or the wallet is locked. Returns any permitted
   * accounts if the wallet is locked and `ignoreLock` is true. This lock bypass is needed
   * for the `eth_requestAccounts` & `wallet_getPermission` handlers both of which
   * return permissioned accounts to the dapp when the wallet is locked.
   *
   * @param {string} origin - The origin whose exposed accounts to retrieve.
   * @param {object} [options] - The options object
   * @param {boolean} [options.ignoreLock] - If accounts should be returned even if the wallet is locked.
   * @returns {Promise<string[]>} The origin's permitted accounts, or an empty
   * array.
   */
  getPermittedAccounts(origin, { ignoreLock } = {}) {
    let caveat;
    try {
      caveat = this.permissionController.getCaveat(
        origin,
        Caip25EndowmentPermissionName,
        Caip25CaveatType,
      );
    } catch (err) {
      if (err instanceof PermissionDoesNotExistError) {
        // suppress expected error in case that the origin
        // does not have the target permission yet
      } else {
        throw err;
      }
    }

    if (!caveat) {
      return [];
    }

    if (!this.isUnlocked() && !ignoreLock) {
      return [];
    }

    const ethAccounts = getEthAccounts(caveat.value);
    return this.sortAccountsByLastSelected(ethAccounts);
  }

  /**
   * Stops exposing the specified chain ID to all third parties.
   *
   * @param {string} targetChainId - The chain ID to stop exposing
   * to third parties.
   */
  removeAllChainIdPermissions(targetChainId) {
    this.permissionController.updatePermissionsByCaveat(
      Caip25CaveatType,
      (existingScopes) =>
        Caip25CaveatMutators[Caip25CaveatType].removeScope(
          existingScopes,
          toCaipChainId('eip155', hexToBigInt(targetChainId).toString(10)),
        ),
    );
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
      Caip25CaveatType,
      (existingScopes) =>
        Caip25CaveatMutators[Caip25CaveatType].removeAccount(
          existingScopes,
          targetAccount,
        ),
    );
  }

  /**
   * Removes an account from state / storage.
   *
   * @param {string[]} address - A hex address
   */
  async removeAccount(address) {
    this._onAccountRemoved(address);
    await this.keyringController.removeAccount(address);

    return address;
  }

  /**
   * Imports an account with the specified import strategy.
   * These are defined in @metamask/keyring-controller
   * Each strategy represents a different way of serializing an Ethereum key pair.
   *
   * @param {'privateKey' | 'json'} strategy - A unique identifier for an account import strategy.
   * @param {any} args - The data required by that strategy to import an account.
   */
  async importAccountWithStrategy(strategy, args) {
    const importedAccountAddress =
      await this.keyringController.importAccountWithStrategy(strategy, args);
    // set new account as selected
    this.preferencesController.setSelectedAddress(importedAccountAddress);
  }

  /**
   * Prompts the user with permittedChains approval for given chainId.
   *
   * @param {string} origin - The origin to request approval for.
   * @param {Hex} chainId - The chainId to add incrementally.
   */
  async requestApprovalPermittedChainsPermission(origin, chainId) {
    const caveatValueWithChains = setPermittedEthChainIds(
      {
        requiredScopes: {},
        optionalScopes: {},
        isMultichainOrigin: false,
      },
      [chainId],
    );

    const id = nanoid();
    await this.approvalController.addAndShowApprovalRequest({
      id,
      origin,
      requestData: {
        metadata: {
          id,
          origin,
        },
        permissions: {
          [Caip25EndowmentPermissionName]: {
            caveats: [
              {
                type: Caip25CaveatType,
                value: caveatValueWithChains,
              },
            ],
          },
        },
        isLegacySwitchEthereumChain: true,
      },
      type: MethodNames.RequestPermissions,
    });
  }

  /**
   * Requests permittedChains permission for the specified origin
   * and replaces any existing CAIP-25 permission with a new one.
   * Allows for granting without prompting for user approval which
   * would be used as part of flows like `wallet_addEthereumChain`
   * requests where the addition of the network and the permitting
   * of the chain are combined into one approval.
   *
   * @param {object} options - The options object
   * @param {string} options.origin - The origin to request approval for.
   * @param {Hex} options.chainId - The chainId to permit.
   * @param {boolean} options.autoApprove - If the chain should be granted without prompting for user approval.
   */
  async requestPermittedChainsPermission({ origin, chainId, autoApprove }) {
    if (isSnapId(origin)) {
      throw new Error(
        `Cannot request permittedChains permission for Snaps with origin "${origin}"`,
      );
    }

    if (!autoApprove) {
      await this.requestApprovalPermittedChainsPermission(origin, chainId);
    }

    let caveatValue = {
      requiredScopes: {},
      optionalScopes: {},
      isMultichainOrigin: false,
    };
    caveatValue = addPermittedEthChainId(caveatValue, chainId);

    this.permissionController.grantPermissions({
      subject: { origin },
      approvedPermissions: {
        [Caip25EndowmentPermissionName]: {
          caveats: [
            {
              type: Caip25CaveatType,
              value: caveatValue,
            },
          ],
        },
      },
    });
  }

  /**
   * Requests incremental permittedChains permission for the specified origin.
   * and updates the existing CAIP-25 permission.
   * Allows for granting without prompting for user approval which
   * would be used as part of flows like `wallet_addEthereumChain`
   * requests where the addition of the network and the permitting
   * of the chain are combined into one approval.
   *
   * @param {object} options - The options object
   * @param {string} options.origin - The origin to request approval for.
   * @param {Hex} options.chainId - The chainId to add to the existing permittedChains.
   * @param {boolean} options.autoApprove - If the chain should be granted without prompting for user approval.
   */
  async requestPermittedChainsPermissionIncremental({
    origin,
    chainId,
    autoApprove,
  }) {
    if (isSnapId(origin)) {
      throw new Error(
        `Cannot request permittedChains permission for Snaps with origin "${origin}"`,
      );
    }

    if (!autoApprove) {
      await this.requestApprovalPermittedChainsPermission(origin, chainId);
    }

    const caip25Caveat = this.permissionController.getCaveat(
      origin,
      Caip25EndowmentPermissionName,
      Caip25CaveatType,
    );

    const caveatValueWithChainsAdded = addPermittedEthChainId(
      caip25Caveat.value,
      chainId,
    );

    const ethAccounts = getEthAccounts(caip25Caveat.value);
    const caveatValueWithAccountsSynced = setEthAccounts(
      caveatValueWithChainsAdded,
      ethAccounts,
    );

    this.permissionController.updateCaveat(
      origin,
      Caip25EndowmentPermissionName,
      Caip25CaveatType,
      caveatValueWithAccountsSynced,
    );
  }

  /**
   * Requests user approval for the CAIP-25 permission for the specified origin
   * and returns a permissions object that must be passed to
   * PermissionController.grantPermissions() to complete the permission granting.
   *
   * @param {string} origin - The origin to request approval for.
   * @param requestedPermissions - The legacy permissions to request approval for.
   * @returns the approved permissions object that must then be granted by calling the PermissionController.
   */
  async requestCaip25Approval(origin, requestedPermissions = {}) {
    const permissions = pick(requestedPermissions, [
      RestrictedMethods.eth_accounts,
      PermissionNames.permittedChains,
    ]);

    const requestedAccounts =
      permissions[RestrictedMethods.eth_accounts]?.caveats?.find(
        (caveat) => caveat.type === CaveatTypes.restrictReturnedAccounts,
      )?.value ?? [];

    const requestedChains =
      permissions[PermissionNames.permittedChains]?.caveats?.find(
        (caveat) => caveat.type === CaveatTypes.restrictNetworkSwitching,
      )?.value ?? [];

    if (permissions[RestrictedMethods.eth_accounts]?.caveats) {
      validateCaveatAccounts(
        requestedAccounts,
        this.accountsController.listAccounts.bind(this.accountsController),
      );
    }

    if (permissions[PermissionNames.permittedChains]?.caveats) {
      validateCaveatNetworks(
        requestedChains,
        this.networkController.findNetworkClientIdByChainId.bind(
          this.networkController,
        ),
      );
    }

    if (!permissions[RestrictedMethods.eth_accounts]) {
      permissions[RestrictedMethods.eth_accounts] = {};
    }

    if (!permissions[PermissionNames.permittedChains]) {
      permissions[PermissionNames.permittedChains] = {};
    }

    if (isSnapId(origin)) {
      delete permissions[PermissionNames.permittedChains];
    }

    const newCaveatValue = {
      requiredScopes: {},
      optionalScopes: {
        'wallet:eip155': {
          accounts: [],
        },
      },
      isMultichainOrigin: false,
    };

    const caveatValueWithChains = setPermittedEthChainIds(
      newCaveatValue,
      isSnapId(origin) ? [] : requestedChains,
    );

    const caveatValueWithAccountsAndChains = setEthAccounts(
      caveatValueWithChains,
      requestedAccounts,
    );

    const id = nanoid();

    const { permissions: approvedPermissions } =
      await this.approvalController.addAndShowApprovalRequest({
        id,
        origin,
        requestData: {
          metadata: {
            id,
            origin,
          },
          permissions: {
            [Caip25EndowmentPermissionName]: {
              caveats: [
                {
                  type: Caip25CaveatType,
                  value: caveatValueWithAccountsAndChains,
                },
              ],
            },
          },
        },
        type: MethodNames.RequestPermissions,
      });

    return approvedPermissions;
  }
  // ---------------------------------------------------------------------------
  // Identity Management (signature operations)

  getAddTransactionRequest({
    transactionParams,
    transactionOptions,
    dappRequest,
    ...otherParams
  }) {
    return {
      internalAccounts: this.accountsController.listAccounts(),
      dappRequest,
      networkClientId:
        dappRequest?.networkClientId ?? this.#getGlobalNetworkClientId(),
      selectedAccount: this.accountsController.getAccountByAddress(
        transactionParams.from,
      ),
      transactionController: this.txController,
      transactionOptions,
      transactionParams,
      userOperationController: this.userOperationController,
      chainId: this.#getGlobalChainId(),
      ppomController: this.ppomController,
      securityAlertsEnabled:
        this.preferencesController.state?.securityAlertsEnabled,
      updateSecurityAlertResponse: this.updateSecurityAlertResponse.bind(this),
      ...otherParams,
    };
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
   * attempt to cancel
   * @param {import(
   *  './controllers/transactions'
   * ).CustomGasSettings} [customGasSettings] - overrides to use for gas params
   * instead of allowing this method to generate them
   * @param options
   * @returns {object} MetaMask state
   */
  async createCancelTransaction(originalTxId, customGasSettings, options) {
    await this.txController.stopTransaction(
      originalTxId,
      customGasSettings,
      options,
    );
    const state = this.getState();
    return state;
  }

  /**
   * Allows a user to attempt to speed up a previously submitted transaction
   * by creating a new transaction.
   *
   * @param {number} originalTxId - the id of the txMeta that you want to
   * attempt to speed up
   * @param {import(
   *  './controllers/transactions'
   * ).CustomGasSettings} [customGasSettings] - overrides to use for gas params
   * instead of allowing this method to generate them
   * @param options
   * @returns {object} MetaMask state
   */
  async createSpeedUpTransaction(originalTxId, customGasSettings, options) {
    await this.txController.speedUpTransaction(
      originalTxId,
      customGasSettings,
      options,
    );
    const state = this.getState();
    return state;
  }

  async estimateGas(estimateGasParams) {
    return new Promise((resolve, reject) => {
      this.provider
        .request({
          method: 'eth_estimateGas',
          params: [estimateGasParams],
        })
        .then((result) => resolve(result.toString(16)))
        .catch((err) => reject(err));
    });
  }

  handleWatchAssetRequest = ({ asset, type, origin, networkClientId }) => {
    switch (type) {
      case ERC20:
        return this.tokensController.watchAsset({
          asset,
          type,
          networkClientId,
        });
      case ERC721:
      case ERC1155:
        return this.nftController.watchNft(asset, type, origin);
      default:
        throw new Error(`Asset type ${type} not supported`);
    }
  };

  async updateSecurityAlertResponse(
    method,
    securityAlertId,
    securityAlertResponse,
  ) {
    await updateSecurityAlertResponse({
      appStateController: this.appStateController,
      method,
      securityAlertId,
      securityAlertResponse,
      signatureController: this.signatureController,
      transactionController: this.txController,
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
  setupUntrustedCommunicationEip1193({
    connectionStream,
    sender,
    subjectType,
  }) {
    if (sender.url) {
      if (this.onboardingController.state.completedOnboarding) {
        if (this.preferencesController.state.usePhishDetect) {
          const { hostname } = new URL(sender.url);
          this.phishingController.maybeUpdateState();
          // Check if new connection is blocked if phishing detection is on
          const phishingTestResponse = this.phishingController.test(sender.url);
          if (phishingTestResponse?.result) {
            this.sendPhishingWarning(connectionStream, hostname);
            this.metaMetricsController.trackEvent({
              event: MetaMetricsEventName.PhishingPageDisplayed,
              category: MetaMetricsEventCategory.Phishing,
              properties: {
                url: hostname,
              },
            });
            return;
          }
        }
      }
    }

    let inputSubjectType;
    if (subjectType) {
      inputSubjectType = subjectType;
    } else if (sender.id && sender.id !== this.extension.runtime.id) {
      inputSubjectType = SubjectType.Extension;
    } else {
      inputSubjectType = SubjectType.Website;
    }

    // setup multiplexing
    const mux = setupMultiplex(connectionStream);

    // messages between inpage and background
    this.setupProviderConnectionEip1193(
      mux.createStream('metamask-provider'),
      sender,
      inputSubjectType,
    );

    // TODO:LegacyProvider: Delete
    if (sender.url) {
      // legacy streams
      this.setupPublicConfig(mux.createStream('publicConfig'));
    }
  }

  /**
   * Used to create a CAIP stream for connecting to an untrusted context.
   *
   * @param options - Options bag.
   * @param {ReadableStream} options.connectionStream - The Duplex stream to connect to.
   * @param {MessageSender | SnapSender} options.sender - The sender of the messages on this stream.
   * @param {string} [options.subjectType] - The type of the sender, i.e. subject.
   */

  setupUntrustedCommunicationCaip({ connectionStream, sender, subjectType }) {
    let inputSubjectType;
    if (subjectType) {
      inputSubjectType = subjectType;
    } else if (sender.id && sender.id !== this.extension.runtime.id) {
      inputSubjectType = SubjectType.Extension;
    } else {
      inputSubjectType = SubjectType.Website;
    }

    const caipStream = createCaipStream(connectionStream);

    // messages between subject and background
    this.setupProviderConnectionCaip(caipStream, sender, inputSubjectType);
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
    this.setupProviderConnectionEip1193(
      mux.createStream('provider'),
      sender,
      SubjectType.Internal,
    );
  }

  /**
   * Used to create a multiplexed stream for connecting to the phishing warning page.
   *
   * @param options - Options bag.
   * @param {ReadableStream} options.connectionStream - The Duplex stream to connect to.
   */
  setupPhishingCommunication({ connectionStream }) {
    const { usePhishDetect } = this.preferencesController.state;

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
        {
          safelistPhishingDomain: this.safelistPhishingDomain.bind(this),
          backToSafetyPhishingWarning:
            this.backToSafetyPhishingWarning.bind(this),
        },
        phishingStream,
      ),
    );
  }

  setUpCookieHandlerCommunication({ connectionStream }) {
    const {
      metaMetricsId,
      dataCollectionForMarketing,
      participateInMetaMetrics,
    } = this.metaMetricsController.state;

    if (
      metaMetricsId &&
      dataCollectionForMarketing &&
      participateInMetaMetrics
    ) {
      // setup multiplexing
      const mux = setupMultiplex(connectionStream);
      const metamaskCookieHandlerStream = mux.createStream(
        METAMASK_COOKIE_HANDLER,
      );
      // set up postStream transport
      metamaskCookieHandlerStream.on(
        'data',
        createMetaRPCHandler(
          {
            getCookieFromMarketingPage:
              this.getCookieFromMarketingPage.bind(this),
          },
          metamaskCookieHandlerStream,
        ),
      );
    }
  }

  getCookieFromMarketingPage(data) {
    const { ga_client_id: cookieId } = data;
    this.metaMetricsController.setMarketingCampaignCookieId(cookieId);
  }

  /**
   * Called when we detect a suspicious domain. Requests the browser redirects
   * to our anti-phishing page.
   *
   * @private
   * @param {*} connectionStream - The duplex stream to the per-page script,
   * for sending the reload attempt to.
   * @param {string} hostname - The hostname that triggered the suspicion.
   */
  sendPhishingWarning(connectionStream, hostname) {
    const mux = setupMultiplex(connectionStream);
    const phishingStream = mux.createStream('phishing');
    phishingStream.write({ hostname });
  }

  /**
   * A method for providing our API over a stream using JSON-RPC.
   *
   * @param {*} outStream - The stream to provide our API over.
   */
  setupControllerConnection(outStream) {
    const patchStore = new PatchStore(this.memStore);
    let uiReady = false;

    const handleUpdate = () => {
      if (!isStreamWritable(outStream) || !uiReady) {
        return;
      }

      const patches = patchStore.flushPendingPatches();

      outStream.write({
        jsonrpc: '2.0',
        method: 'sendUpdate',
        params: [patches],
      });
    };

    const api = {
      ...this.getApi(),
      ...this.controllerApi,
      startPatches: () => {
        uiReady = true;
        handleUpdate();
      },
      getStatePatches: () => patchStore.flushPendingPatches(),
    };

    this.on('update', handleUpdate);

    // report new active controller connection
    this.activeControllerConnections += 1;
    this.emit('controllerConnectionChanged', this.activeControllerConnections);

    // set up postStream transport
    outStream.on('data', createMetaRPCHandler(api, outStream));

    const startUISync = () => {
      if (!isStreamWritable(outStream)) {
        return;
      }
      // send notification to client-side
      outStream.write({
        jsonrpc: '2.0',
        method: 'startUISync',
      });
    };

    if (this.startUISync) {
      startUISync();
    } else {
      this.once('startUISync', startUISync);
    }

    const outstreamEndHandler = () => {
      if (!outStream.mmFinished) {
        this.activeControllerConnections -= 1;
        this.emit(
          'controllerConnectionChanged',
          this.activeControllerConnections,
        );
        outStream.mmFinished = true;
        this.removeListener('update', handleUpdate);
        patchStore.destroy();
      }
    };

    // The presence of both of the below handlers may be redundant.
    // After upgrading metamask/object-multiples to v2.0.0, which included
    // an upgrade of readable-streams from v2 to v3, we saw that the
    // `outStream.on('end'` handler was almost never being called. This seems to
    // related to how v3 handles errors vs how v2 handles errors; there
    // are "premature close" errors in both cases, although in the case
    // of v2 they don't prevent `outStream.on('end'` from being called.
    // At the time that this comment was committed, it was known that we
    // need to investigate and resolve the underlying error, however,
    // for expediency, we are not addressing them at this time. Instead, we
    // can observe that `readableStream.finished` preserves the same
    // functionality as we had when we relied on readable-stream v2. Meanwhile,
    // the `outStream.on('end')` handler was observed to have been called at least once.
    // In an abundance of caution to prevent against unexpected future behavioral changes in
    // streams implementations, we redundantly use multiple paths to attach the same event handler.
    // The outstreamEndHandler therefore needs to be idempotent, which introduces the `mmFinished` property.

    outStream.mmFinished = false;
    finished(outStream, outstreamEndHandler);
    outStream.once('close', outstreamEndHandler);
    outStream.once('end', outstreamEndHandler);
  }

  /**
   * A method for serving our ethereum provider over a given stream.
   *
   * @param {*} outStream - The stream to provide over.
   * @param {MessageSender | SnapSender} sender - The sender of the messages on this stream
   * @param {SubjectType} subjectType - The type of the sender, i.e. subject.
   */
  setupProviderConnectionEip1193(outStream, sender, subjectType) {
    let origin;
    if (subjectType === SubjectType.Internal) {
      origin = ORIGIN_METAMASK;
    } else if (subjectType === SubjectType.Snap) {
      origin = sender.snapId;
    } else {
      origin = new URL(sender.url).origin;
    }

    if (sender.id && sender.id !== this.extension.runtime.id) {
      this.subjectMetadataController.addSubjectMetadata({
        origin,
        extensionId: sender.id,
        subjectType: SubjectType.Extension,
      });
    }

    let tabId;
    if (sender.tab && sender.tab.id) {
      tabId = sender.tab.id;
    }

    let mainFrameOrigin = origin;
    if (sender.tab && sender.tab.url) {
      // If sender origin is an iframe, then get the top-level frame's origin
      mainFrameOrigin = new URL(sender.tab.url).origin;
    }

    const engine = this.setupProviderEngineEip1193({
      origin,
      sender,
      subjectType,
      tabId,
      mainFrameOrigin,
    });

    const dupeReqFilterStream = createDupeReqFilterStream();

    // setup connection
    const providerStream = createEngineStream({ engine });

    const connectionId = this.addConnection(origin, { engine });

    pipeline(
      outStream,
      dupeReqFilterStream,
      providerStream,
      outStream,
      (err) => {
        // handle any middleware cleanup
        engine.destroy();
        connectionId && this.removeConnection(origin, connectionId);
        // For context and todos related to the error message match, see https://github.com/MetaMask/metamask-extension/issues/26337
        if (err && !err.message?.match('Premature close')) {
          log.error(err);
        }
      },
    );

    // Used to show wallet liveliness to the provider
    if (subjectType !== SubjectType.Internal) {
      this._notifyChainChangeForConnection({ engine }, origin);
    }
  }

  /**
   * A method for serving our CAIP provider over a given stream.
   *
   * @param {*} outStream - The stream to provide over.
   * @param {MessageSender | SnapSender} sender - The sender of the messages on this stream
   * @param {SubjectType} subjectType - The type of the sender, i.e. subject.
   */
  setupProviderConnectionCaip(outStream, sender, subjectType) {
    let origin;
    if (subjectType === SubjectType.Internal) {
      origin = ORIGIN_METAMASK;
    } else if (subjectType === SubjectType.Snap) {
      origin = sender.snapId;
    } else {
      origin = new URL(sender.url).origin;
    }

    if (sender.id && sender.id !== this.extension.runtime.id) {
      this.subjectMetadataController.addSubjectMetadata({
        origin,
        extensionId: sender.id,
        subjectType: SubjectType.Extension,
      });
    }

    let tabId;
    if (sender.tab && sender.tab.id) {
      tabId = sender.tab.id;
    }

    const engine = this.setupProviderEngineCaip({
      origin,
      tabId,
    });

    const dupeReqFilterStream = createDupeReqFilterStream();

    // setup connection
    const providerStream = createEngineStream({ engine });

    const connectionId = this.addConnection(origin, { engine });

    pipeline(
      outStream,
      dupeReqFilterStream,
      providerStream,
      outStream,
      (err) => {
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
      },
    );

    // Used to show wallet liveliness to the provider
    if (subjectType !== SubjectType.Internal) {
      this._notifyChainChangeForConnection({ engine }, origin);
    }
  }

  /**
   * A method for creating an ethereum provider that is safely restricted for the requesting subject.
   *
   * @param {object} options - Provider engine options
   * @param {string} options.origin - The origin of the sender
   * @param {MessageSender | SnapSender} options.sender - The sender object.
   * @param {string} options.subjectType - The type of the sender subject.
   * @param {tabId} [options.tabId] - The tab ID of the sender - if the sender is within a tab
   * @param {mainFrameOrigin} [options.mainFrameOrigin] - The origin of the main frame if the sender is an iframe
   */
  setupProviderEngineEip1193({
    origin,
    subjectType,
    sender,
    tabId,
    mainFrameOrigin,
  }) {
    const engine = new JsonRpcEngine();

    // Append origin to each request
    engine.push(createOriginMiddleware({ origin }));

    // Append mainFrameOrigin to each request if present
    if (mainFrameOrigin) {
      engine.push(createMainFrameOriginMiddleware({ mainFrameOrigin }));
    }

    // Append selectedNetworkClientId to each request
    engine.push(createSelectedNetworkMiddleware(this.controllerMessenger));

    // Add a middleware that will switch chain on each request (as needed)
    const requestQueueMiddleware = createQueuedRequestMiddleware({
      enqueueRequest: this.queuedRequestController.enqueueRequest.bind(
        this.queuedRequestController,
      ),
      shouldEnqueueRequest: (request) => {
        return methodsThatShouldBeEnqueued.includes(request.method);
      },
      // This will be removed once we can actually remove useRequestQueue state
      // i.e. unrevert https://github.com/MetaMask/core/pull/5065
      useRequestQueue: () => true,
    });
    engine.push(requestQueueMiddleware);

    // If the origin is not in the selectedNetworkController's `domains` state
    // when the provider engine is created, the selectedNetworkController will
    // fetch the globally selected networkClient from the networkController and wrap
    // it in a proxy which can be switched to use its own state if/when the origin
    // is added to the `domains` state
    const proxyClient =
      this.selectedNetworkController.getProviderAndBlockTracker(origin);

    // We create the filter and subscription manager middleware now, but they will
    // be inserted into the engine later.
    const filterMiddleware = createFilterMiddleware(proxyClient);
    const subscriptionManager = createSubscriptionManager(proxyClient);
    subscriptionManager.events.on('notification', (message) =>
      engine.emit('notification', message),
    );

    // Append tabId to each request if it exists
    if (tabId) {
      engine.push(createTabIdMiddleware({ tabId }));
    }

    engine.push(createLoggerMiddleware({ origin }));
    engine.push(this.permissionLogController.createMiddleware());

    if (origin === BaseUrl.Portfolio) {
      engine.push(createTxVerificationMiddleware(this.networkController));
    }

    engine.push(createTracingMiddleware());

    engine.push(
      createOriginThrottlingMiddleware({
        getThrottledOriginState:
          this.appStateController.getThrottledOriginState.bind(
            this.appStateController,
          ),
        updateThrottledOriginState:
          this.appStateController.updateThrottledOriginState.bind(
            this.appStateController,
          ),
      }),
    );

    engine.push(
      createPPOMMiddleware(
        this.ppomController,
        this.preferencesController,
        this.networkController,
        this.appStateController,
        this.accountsController,
        this.updateSecurityAlertResponse.bind(this),
      ),
    );

    engine.push(
      createRPCMethodTrackingMiddleware({
        getAccountType: this.getAccountType.bind(this),
        getDeviceModel: this.getDeviceModel.bind(this),
        getHardwareTypeForMetric: this.getHardwareTypeForMetric.bind(this),
        snapAndHardwareMessenger: this.controllerMessenger.getRestricted({
          name: 'SnapAndHardwareMessenger',
          allowedActions: [
            'KeyringController:getKeyringForAccount',
            'SnapController:get',
            'AccountsController:getSelectedAccount',
          ],
        }),
        appStateController: this.appStateController,
        metaMetricsController: this.metaMetricsController,
      }),
    );

    engine.push(createUnsupportedMethodMiddleware());

    // Legacy RPC methods that need to be implemented _ahead of_ the permission
    // middleware.
    engine.push(
      createEthAccountsMethodMiddleware({
        getAccounts: this.getPermittedAccounts.bind(this, origin),
      }),
    );

    if (subjectType !== SubjectType.Internal) {
      engine.push(
        this.permissionController.createPermissionMiddleware({
          origin,
        }),
      );
    }

    if (subjectType === SubjectType.Website) {
      engine.push(
        createOnboardingMiddleware({
          location: sender.url,
          registerOnboarding: this.onboardingController.registerOnboarding,
        }),
      );
    }

    // EVM requests and eth permissions should not be passed to non-EVM accounts
    // this middleware intercepts these requests and returns an error.
    engine.push(
      createEvmMethodsToNonEvmAccountReqFilterMiddleware({
        messenger: this.controllerMessenger.getRestricted({
          name: 'EvmMethodsToNonEvmAccountFilterMessenger',
          allowedActions: ['AccountsController:getSelectedAccount'],
        }),
      }),
    );

    // Unrestricted/permissionless RPC method implementations.
    // They must nevertheless be placed _behind_ the permission middleware.
    engine.push(
      createEip1193MethodMiddleware({
        subjectType,

        // Miscellaneous
        addSubjectMetadata:
          this.subjectMetadataController.addSubjectMetadata.bind(
            this.subjectMetadataController,
          ),
        metamaskState: this.getState(),
        getProviderState: this.getProviderState.bind(this),
        getUnlockPromise: this.appStateController.getUnlockPromise.bind(
          this.appStateController,
        ),
        handleWatchAssetRequest: this.handleWatchAssetRequest.bind(this),
        requestUserApproval:
          this.approvalController.addAndShowApprovalRequest.bind(
            this.approvalController,
          ),
        sendMetrics: this.metaMetricsController.trackEvent.bind(
          this.metaMetricsController,
        ),
        // Permission-related
        getAccounts: this.getPermittedAccounts.bind(this, origin),
        requestCaip25ApprovalForOrigin: this.requestCaip25Approval.bind(
          this,
          origin,
        ),
        grantPermissionsForOrigin: (approvedPermissions) => {
          return this.permissionController.grantPermissions({
            subject: { origin },
            approvedPermissions,
          });
        },
        getPermissionsForOrigin: this.permissionController.getPermissions.bind(
          this.permissionController,
          origin,
        ),
        requestPermittedChainsPermissionForOrigin: (options) =>
          this.requestPermittedChainsPermission({
            ...options,
            origin,
          }),
        requestPermittedChainsPermissionIncrementalForOrigin: (options) =>
          this.requestPermittedChainsPermissionIncremental({
            ...options,
            origin,
          }),
        requestPermissionsForOrigin: (requestedPermissions) =>
          this.permissionController.requestPermissions(
            { origin },
            requestedPermissions,
          ),
        revokePermissionsForOrigin: (permissionKeys) => {
          try {
            this.permissionController.revokePermissions({
              [origin]: permissionKeys,
            });
          } catch (e) {
            // we dont want to handle errors here because
            // the revokePermissions api method should just
            // return `null` if the permissions were not
            // successfully revoked or if the permissions
            // for the origin do not exist
            console.log(e);
          }
        },
        getCaveat: ({ target, caveatType }) => {
          try {
            return this.permissionController.getCaveat(
              origin,
              target,
              caveatType,
            );
          } catch (e) {
            if (e instanceof PermissionDoesNotExistError) {
              // suppress expected error in case that the origin
              // does not have the target permission yet
            } else {
              throw e;
            }
          }

          return undefined;
        },
        // network configuration-related
        setActiveNetwork: async (networkClientId) => {
          await this.networkController.setActiveNetwork(networkClientId);
          // if the origin has the CAIP-25 permission
          // we set per dapp network selection state
          if (
            this.permissionController.hasPermission(
              origin,
              Caip25EndowmentPermissionName,
            )
          ) {
            this.selectedNetworkController.setNetworkClientIdForDomain(
              origin,
              networkClientId,
            );
          }
        },
        addNetwork: this.networkController.addNetwork.bind(
          this.networkController,
        ),
        updateNetwork: this.networkController.updateNetwork.bind(
          this.networkController,
        ),
        getNetworkConfigurationByChainId:
          this.networkController.getNetworkConfigurationByChainId.bind(
            this.networkController,
          ),
        setTokenNetworkFilter: (chainId) => {
          const { tokenNetworkFilter } =
            this.preferencesController.getPreferences();
          if (chainId && Object.keys(tokenNetworkFilter).length === 1) {
            this.preferencesController.setPreference('tokenNetworkFilter', {
              [chainId]: true,
            });
          }
        },
        getCurrentChainIdForDomain: (domain) => {
          const networkClientId =
            this.selectedNetworkController.getNetworkClientIdForDomain(domain);
          const { chainId } =
            this.networkController.getNetworkConfigurationByNetworkClientId(
              networkClientId,
            );
          return chainId;
        },

        // Web3 shim-related
        getWeb3ShimUsageState: this.alertController.getWeb3ShimUsageState.bind(
          this.alertController,
        ),
        setWeb3ShimUsageRecorded:
          this.alertController.setWeb3ShimUsageRecorded.bind(
            this.alertController,
          ),
        updateCaveat: this.permissionController.updateCaveat.bind(
          this.permissionController,
          origin,
        ),

        ///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
        handleMmiAuthenticate:
          this.institutionalFeaturesController.handleMmiAuthenticate.bind(
            this.institutionalFeaturesController,
          ),
        handleMmiCheckIfTokenIsPresent:
          this.mmiController.handleMmiCheckIfTokenIsPresent.bind(
            this.mmiController,
          ),
        handleMmiDashboardData: this.mmiController.handleMmiDashboardData.bind(
          this.mmiController,
        ),
        handleMmiSetAccountAndNetwork:
          this.mmiController.setAccountAndNetwork.bind(this.mmiController),
        handleMmiOpenAddHardwareWallet:
          this.mmiController.handleMmiOpenAddHardwareWallet.bind(
            this.mmiController,
          ),
        ///: END:ONLY_INCLUDE_IF
      }),
    );

    engine.push(
      createSnapsMethodMiddleware(subjectType === SubjectType.Snap, {
        clearSnapState: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapController:clearSnapState',
          origin,
        ),
        getUnlockPromise: this.appStateController.getUnlockPromise.bind(
          this.appStateController,
        ),
        getSnaps: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapController:getPermitted',
          origin,
        ),
        requestPermissions: async (requestedPermissions) =>
          await this.permissionController.requestPermissions(
            { origin },
            requestedPermissions,
          ),
        getPermissions: this.permissionController.getPermissions.bind(
          this.permissionController,
          origin,
        ),
        getSnapFile: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapController:getFile',
          origin,
        ),
        getSnapState: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapController:getSnapState',
          origin,
        ),
        updateSnapState: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapController:updateSnapState',
          origin,
        ),
        installSnaps: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapController:install',
          origin,
        ),
        invokeSnap: this.permissionController.executeRestrictedMethod.bind(
          this.permissionController,
          origin,
          RestrictedMethods.wallet_snap,
        ),
        getIsLocked: () => {
          return !this.appStateController.isUnlocked();
        },
        getInterfaceState: (...args) =>
          this.controllerMessenger.call(
            'SnapInterfaceController:getInterface',
            origin,
            ...args,
          ).state,
        getInterfaceContext: (...args) =>
          this.controllerMessenger.call(
            'SnapInterfaceController:getInterface',
            origin,
            ...args,
          ).context,
        createInterface: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapInterfaceController:createInterface',
          origin,
        ),
        updateInterface: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapInterfaceController:updateInterface',
          origin,
        ),
        resolveInterface: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapInterfaceController:resolveInterface',
          origin,
        ),
        getSnap: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapController:get',
        ),
        getAllSnaps: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'SnapController:getAll',
        ),
        getCurrencyRate: (currency) => {
          const rate = this.multichainRatesController.state.rates[currency];
          const { fiatCurrency } = this.multichainRatesController.state;

          if (!rate) {
            return undefined;
          }

          return {
            ...rate,
            currency: fiatCurrency,
          };
        },
        hasPermission: this.permissionController.hasPermission.bind(
          this.permissionController,
          origin,
        ),
        scheduleBackgroundEvent: (event) =>
          this.controllerMessenger.call(
            'CronjobController:scheduleBackgroundEvent',
            { ...event, snapId: origin },
          ),
        cancelBackgroundEvent: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'CronjobController:cancelBackgroundEvent',
          origin,
        ),
        getBackgroundEvents: this.controllerMessenger.call.bind(
          this.controllerMessenger,
          'CronjobController:getBackgroundEvents',
          origin,
        ),
        ///: BEGIN:ONLY_INCLUDE_IF(keyring-snaps)
        handleSnapRpcRequest: (args) =>
          this.handleSnapRequest({ ...args, origin }),
        getAllowedKeyringMethods: keyringSnapPermissionsBuilder(
          this.subjectMetadataController,
          origin,
        ),
        ///: END:ONLY_INCLUDE_IF
      }),
    );

    engine.push(filterMiddleware);
    engine.push(subscriptionManager.middleware);

    engine.push(this.metamaskMiddleware);

    engine.push(providerAsMiddleware(proxyClient.provider));

    return engine;
  }

  /**
   * A method for creating a CAIP provider that is safely restricted for the requesting subject.
   *
   * @param {object} options - Provider engine options
   * @param {string} options.origin - The origin of the sender
   * @param {tabId} [options.tabId] - The tab ID of the sender - if the sender is within a tab
   */
  setupProviderEngineCaip({ origin, tabId }) {
    const engine = new JsonRpcEngine();

    engine.push((request, _res, _next, end) => {
      console.log('CAIP request received', { origin, tabId, request });
      return end(new Error('CAIP RPC Pipeline not yet implemented.'));
    });

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

    pipeline(configStream, outStream, (err) => {
      configStream.destroy();
      // For context and todos related to the error message match, see https://github.com/MetaMask/metamask-extension/issues/26337
      if (err && !err.message?.match('Premature close')) {
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
        try {
          this.notifyConnection(conn, await getPayload(origin));
        } catch (err) {
          console.error(err);
        }
      });
    });
  }

  /**
   * Causes the RPC engine for passed connection to emit a
   * notification event with the given payload.
   *
   * The caller is responsible for ensuring that only permitted notifications
   * are sent.
   *
   * @param {object} connection - Data associated with the connection
   * @param {object} connection.engine - The connection's JSON Rpc Engine
   * @param {unknown} payload - The event payload
   */
  notifyConnection(connection, payload) {
    try {
      if (connection.engine) {
        connection.engine.emit('notification', payload);
      }
    } catch (err) {
      console.error(err);
    }
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

    // The accounts tracker only supports EVM addresses and the keyring
    // controller may pass non-EVM addresses, so we filter them out
    const addresses = keyrings
      .reduce((acc, { accounts }) => acc.concat(accounts), [])
      .filter(isEthAddress);

    if (!addresses.length) {
      return;
    }

    this.accountTrackerController.syncWithAddresses(addresses);
  }

  /**
   * Handle global application unlock.
   * Notifies all connections that the extension is unlocked, and which
   * account(s) are currently accessible, if any.
   */
  _onUnlock() {
    this.notifyAllConnections((origin) => {
      return {
        method: NOTIFICATION_NAMES.unlockStateChanged,
        params: {
          isUnlocked: true,
          accounts: this.getPermittedAccounts(origin),
        },
      };
    });

    this.unMarkPasswordForgotten();

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
    this._notifyChainChange();
  }

  /**
   * Execute side effects of a removed account.
   *
   * @param {string} address - The address of the account to remove.
   */
  _onAccountRemoved(address) {
    // Remove all associated permissions
    this.removeAllAccountPermissions(address);

    ///: BEGIN:ONLY_INCLUDE_IF(build-mmi)
    this.custodyController.removeAccount(address);
    ///: END:ONLY_INCLUDE_IF(build-mmi)
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
    return this.keyringController.state.isUnlocked;
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
   * The chain list is fetched live at runtime, falling back to a cache.
   * This preseeds the cache at startup with a static list provided at build.
   */
  async initializeChainlist() {
    const cacheKey = `cachedFetch:${CHAIN_SPEC_URL}`;
    const { cachedResponse } = (await getStorageItem(cacheKey)) || {};
    if (cachedResponse) {
      return;
    }
    await setStorageItem(cacheKey, {
      cachedResponse: rawChainData(),
      // Cached value is immediately invalidated
      cachedTime: 0,
    });
  }

  /**
   * Returns the nonce that will be associated with a transaction once approved
   *
   * @param {string} address - The hex string address for the transaction
   * @param networkClientId - The networkClientId to get the nonce lock with
   * @returns {Promise<number>}
   */
  async getPendingNonce(address, networkClientId) {
    const { nonceDetails, releaseLock } = await this.txController.getNonceLock(
      address,
      networkClientId,
    );

    const pendingNonce = nonceDetails.params.highestSuggested;

    releaseLock();
    return pendingNonce;
  }

  /**
   * Returns the next nonce according to the nonce-tracker
   *
   * @param {string} address - The hex string address for the transaction
   * @param networkClientId - The networkClientId to get the nonce lock with
   * @returns {Promise<number>}
   */
  async getNextNonce(address, networkClientId) {
    const nonceLock = await this.txController.getNonceLock(
      address,
      networkClientId,
    );
    nonceLock.releaseLock();
    return nonceLock.nextNonce;
  }

  /**
   * Throw an artificial error in a timeout handler for testing purposes.
   *
   * @param message - The error message.
   * @deprecated This is only mean to facilitiate E2E testing. We should not
   * use this for handling errors.
   */
  throwTestError(message) {
    setTimeout(() => {
      const error = new Error(message);
      error.name = 'TestError';
      throw error;
    });
  }

  /**
   * A method for setting BridgeStatusController event listeners
   */
  _addBridgeStatusControllerListeners() {
    this.controllerMessenger.subscribe(
      'BridgeStatusController:bridgeTransactionComplete',
      (payload) =>
        handleBridgeTransactionComplete(payload, {
          backgroundState: this.getState(),
          trackEvent: this.metaMetricsController.trackEvent.bind(
            this.metaMetricsController,
          ),
        }),
    );

    this.controllerMessenger.subscribe(
      'BridgeStatusController:bridgeTransactionFailed',
      (payload) =>
        handleBridgeTransactionFailed(payload, {
          backgroundState: this.getState(),
          trackEvent: this.metaMetricsController.trackEvent.bind(
            this.metaMetricsController,
          ),
        }),
    );
    // Putting these TransactionController listeners here to keep it colocated with the other bridge events
    this.controllerMessenger.subscribe(
      'TransactionController:transactionFailed',
      (payload) => {
        if (payload.transactionMeta.type === TransactionType.bridge) {
          handleTransactionFailedTypeBridge(payload, {
            backgroundState: this.getState(),
            trackEvent: this.metaMetricsController.trackEvent.bind(
              this.metaMetricsController,
            ),
          });
        }
      },
    );
  }

  getTransactionMetricsRequest() {
    const controllerActions = {
      // Metametrics Actions
      createEventFragment: this.metaMetricsController.createEventFragment.bind(
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
      getParticipateInMetrics: () =>
        this.metaMetricsController.state.participateInMetaMetrics,
      trackEvent: this.metaMetricsController.trackEvent.bind(
        this.metaMetricsController,
      ),
      updateEventFragment: this.metaMetricsController.updateEventFragment.bind(
        this.metaMetricsController,
      ),
      // Other dependencies
      getAccountType: this.getAccountType.bind(this),
      getDeviceModel: this.getDeviceModel.bind(this),
      getHardwareTypeForMetric: this.getHardwareTypeForMetric.bind(this),
      getEIP1559GasFeeEstimates:
        this.gasFeeController.fetchGasFeeEstimates.bind(this.gasFeeController),
      getSelectedAddress: () =>
        this.accountsController.getSelectedAccount().address,
      getTokenStandardAndDetails: this.getTokenStandardAndDetails.bind(this),
      getTransaction: (id) =>
        this.txController.state.transactions.find((tx) => tx.id === id),
      getIsSmartTransaction: () => {
        return getIsSmartTransaction(this._getMetaMaskState());
      },
      getSmartTransactionByMinedTxHash: (txHash) => {
        return this.smartTransactionsController.getSmartTransactionByMinedTxHash(
          txHash,
        );
      },
      getMethodData: (data) => {
        if (!data) {
          return null;
        }
        const { knownMethodData, use4ByteResolution } =
          this.preferencesController.state;
        const prefixedData = addHexPrefix(data);
        return getMethodDataName(
          knownMethodData,
          use4ByteResolution,
          prefixedData,
          this.preferencesController.addKnownMethodData.bind(
            this.preferencesController,
          ),
          this.provider,
        );
      },
      getIsConfirmationAdvancedDetailsOpen: () => {
        return this.preferencesController.state.preferences
          .showConfirmationAdvancedDetails;
      },
    };
    return {
      ...controllerActions,
      snapAndHardwareMessenger: this.controllerMessenger.getRestricted({
        name: 'SnapAndHardwareMessenger',
        allowedActions: [
          'KeyringController:getKeyringForAccount',
          'SnapController:get',
          'AccountsController:getSelectedAccount',
        ],
      }),
      provider: this.provider,
    };
  }

  toggleExternalServices(useExternal) {
    this.preferencesController.toggleExternalServices(useExternal);
    this.tokenListController.updatePreventPollingOnNetworkRestart(!useExternal);
    if (useExternal) {
      this.tokenDetectionController.enable();
      this.gasFeeController.enableNonRPCGasFeeApis();
    } else {
      this.tokenDetectionController.disable();
      this.gasFeeController.disableNonRPCGasFeeApis();
    }
  }

  //=============================================================================
  // CONFIG
  //=============================================================================

  /**
   * Sets the Ledger Live preference to use for Ledger hardware wallet support
   *
   * @param keyring
   * @deprecated This method is deprecated and will be removed in the future.
   * Only webhid connections are supported in chrome and u2f in firefox.
   */
  async setLedgerTransportPreference(keyring) {
    const transportType = window.navigator.hid
      ? LedgerTransportTypes.webhid
      : LedgerTransportTypes.u2f;

    if (keyring?.updateTransportMethod) {
      return keyring.updateTransportMethod(transportType).catch((e) => {
        throw e;
      });
    }

    return undefined;
  }

  /**
   * A method for initializing storage the first time.
   *
   * @param {object} initState - The default state to initialize with.
   * @private
   */
  recordFirstTimeInfo(initState) {
    if (!('firstTimeInfo' in initState)) {
      const version = process.env.METAMASK_VERSION;
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
  }
  /* eslint-enable accessor-pairs */

  /**
   * A method that is called by the background when all instances of metamask are closed.
   * Currently used to stop controller polling.
   */
  onClientClosed() {
    try {
      this.gasFeeController.stopAllPolling();
      this.currencyRateController.stopAllPolling();
      this.tokenRatesController.stopAllPolling();
      this.tokenDetectionController.stopAllPolling();
      this.tokenListController.stopAllPolling();
      this.tokenBalancesController.stopAllPolling();
      this.appStateController.clearPollingTokens();
      this.accountTrackerController.stopAllPolling();
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * A method that is called by the background when a particular environment type is closed (fullscreen, popup, notification).
   * Currently used to stop polling controllers for only that environement type
   *
   * @param environmentType
   */
  onEnvironmentTypeClosed(environmentType) {
    const appStatePollingTokenType =
      POLLING_TOKEN_ENVIRONMENT_TYPES[environmentType];
    const pollingTokensToDisconnect =
      this.appStateController.state[appStatePollingTokenType];
    pollingTokensToDisconnect.forEach((pollingToken) => {
      // We don't know which controller the token is associated with, so try them all.
      // Consider storing the tokens per controller in state instead.
      this.gasFeeController.stopPollingByPollingToken(pollingToken);
      this.currencyRateController.stopPollingByPollingToken(pollingToken);
      this.tokenRatesController.stopPollingByPollingToken(pollingToken);
      this.tokenDetectionController.stopPollingByPollingToken(pollingToken);
      this.tokenListController.stopPollingByPollingToken(pollingToken);
      this.tokenBalancesController.stopPollingByPollingToken(pollingToken);
      this.accountTrackerController.stopPollingByPollingToken(pollingToken);
      this.appStateController.removePollingToken(
        pollingToken,
        appStatePollingTokenType,
      );
    });
  }

  /**
   * Adds a domain to the PhishingController safelist
   *
   * @param {string} origin - the domain to safelist
   */
  safelistPhishingDomain(origin) {
    this.metaMetricsController.trackEvent({
      category: MetaMetricsEventCategory.Phishing,
      event: MetaMetricsEventName.ProceedAnywayClicked,
      properties: {
        url: origin,
        referrer: {
          url: origin,
        },
      },
    });

    return this.phishingController.bypass(origin);
  }

  async backToSafetyPhishingWarning() {
    const portfolioBaseURL = process.env.PORTFOLIO_URL;
    const portfolioURL = `${portfolioBaseURL}/?metamaskEntry=phishing_page_portfolio_button`;

    this.metaMetricsController.trackEvent({
      category: MetaMetricsEventCategory.Navigation,
      event: MetaMetricsEventName.PortfolioLinkClicked,
      properties: {
        location: 'phishing_page',
        text: 'Back to safety',
      },
    });

    await this.platform.switchToAnotherURL(undefined, portfolioURL);
  }

  /**
   * Locks MetaMask
   */
  setLocked() {
    return this.keyringController.setLocked();
  }

  removePermissionsFor = (subjects) => {
    try {
      this.permissionController.revokePermissions(subjects);
    } catch (exp) {
      if (!(exp instanceof PermissionsRequestNotFoundError)) {
        throw exp;
      }
    }
  };

  updateCaveat = (origin, target, caveatType, caveatValue) => {
    try {
      this.controllerMessenger.call(
        'PermissionController:updateCaveat',
        origin,
        target,
        caveatType,
        caveatValue,
      );
    } catch (exp) {
      if (!(exp instanceof PermissionsRequestNotFoundError)) {
        throw exp;
      }
    }
  };

  updateNetworksList = (chainIds) => {
    try {
      this.networkOrderController.updateNetworksList(chainIds);
    } catch (err) {
      log.error(err.message);
      throw err;
    }
  };

  updateAccountsList = (pinnedAccountList) => {
    try {
      this.accountOrderController.updateAccountsList(pinnedAccountList);
    } catch (err) {
      log.error(err.message);
      throw err;
    }
  };

  updateHiddenAccountsList = (hiddenAccountList) => {
    try {
      this.accountOrderController.updateHiddenAccountsList(hiddenAccountList);
    } catch (err) {
      log.error(err.message);
      throw err;
    }
  };

  rejectPermissionsRequest = (requestId) => {
    try {
      this.permissionController.rejectPermissionsRequest(requestId);
    } catch (exp) {
      if (!(exp instanceof PermissionsRequestNotFoundError)) {
        throw exp;
      }
    }
  };

  acceptPermissionsRequest = (request) => {
    try {
      this.permissionController.acceptPermissionsRequest(request);
    } catch (exp) {
      if (!(exp instanceof PermissionsRequestNotFoundError)) {
        throw exp;
      }
    }
  };

  resolvePendingApproval = async (id, value, options) => {
    try {
      await this.approvalController.accept(id, value, options);
    } catch (exp) {
      if (!(exp instanceof ApprovalRequestNotFoundError)) {
        throw exp;
      }
    }
  };

  rejectPendingApproval = (id, error) => {
    try {
      this.approvalController.reject(
        id,
        new JsonRpcError(error.code, error.message, error.data),
      );
    } catch (exp) {
      if (!(exp instanceof ApprovalRequestNotFoundError)) {
        throw exp;
      }
    }
  };

  rejectAllPendingApprovals() {
    const deleteInterface = (id) =>
      this.controllerMessenger.call(
        'SnapInterfaceController:deleteInterface',
        id,
      );

    rejectAllApprovals({
      approvalController: this.approvalController,
      deleteInterface,
    });
  }

  async _onAccountChange(newAddress) {
    const permittedAccountsMap = getPermittedAccountsByOrigin(
      this.permissionController.state,
    );

    for (const [origin, accounts] of permittedAccountsMap.entries()) {
      if (accounts.includes(newAddress)) {
        this._notifyAccountsChange(origin, accounts);
      }
    }

    await this.txController.updateIncomingTransactions([
      this.#getGlobalChainId(),
    ]);
  }

  _notifyAccountsChange(origin, newAccounts) {
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
              this.getPermittedAccounts(origin),
      });
    }

    this.permissionLogController.updateAccountsHistory(origin, newAccounts);
  }

  async _notifyChainChange() {
    this.notifyAllConnections(async (origin) => ({
      method: NOTIFICATION_NAMES.chainChanged,
      params: await this.getProviderNetworkState(origin),
    }));
  }

  async _notifyChainChangeForConnection(connection, origin) {
    this.notifyConnection(connection, {
      method: NOTIFICATION_NAMES.chainChanged,
      params: await this.getProviderNetworkState(origin),
    });
  }

  /**
   * @deprecated
   * Controllers should subscribe to messenger events internally rather than relying on the client.
   * @param transactionMeta - Metadata for the transaction.
   */
  async _onFinishedTransaction(transactionMeta) {
    if (
      ![TransactionStatus.confirmed, TransactionStatus.failed].includes(
        transactionMeta.status,
      )
    ) {
      return;
    }

    await this._createTransactionNotifcation(transactionMeta);
    await this._updateNFTOwnership(transactionMeta);
    this._trackTransactionFailure(transactionMeta);
    await this.tokenBalancesController.updateBalancesByChainId({
      chainId: transactionMeta.chainId,
    });
  }

  async _createTransactionNotifcation(transactionMeta) {
    const { chainId } = transactionMeta;
    let rpcPrefs = {};

    if (chainId) {
      const networkConfiguration =
        this.networkController.state.networkConfigurationsByChainId?.[chainId];

      const blockExplorerUrl =
        networkConfiguration?.blockExplorerUrls?.[
          networkConfiguration?.defaultBlockExplorerUrlIndex
        ];

      rpcPrefs = { blockExplorerUrl };
    }

    try {
      await this.platform.showTransactionNotification(
        transactionMeta,
        rpcPrefs,
      );
    } catch (error) {
      log.error('Failed to create transaction notification', error);
    }
  }

  async _updateNFTOwnership(transactionMeta) {
    // if this is a transferFrom method generated from within the app it may be an NFT transfer transaction
    // in which case we will want to check and update ownership status of the transferred NFT.

    const { type, txParams, chainId, txReceipt } = transactionMeta;
    const selectedAddress =
      this.accountsController.getSelectedAccount().address;

    const { allNfts } = this.nftController.state;
    const txReceiptLogs = txReceipt?.logs;

    const isContractInteractionTx =
      type === TransactionType.contractInteraction && txReceiptLogs;
    const isTransferFromTx =
      (type === TransactionType.tokenMethodTransferFrom ||
        type === TransactionType.tokenMethodSafeTransferFrom) &&
      txParams !== undefined;

    if (!isContractInteractionTx && !isTransferFromTx) {
      return;
    }

    if (isTransferFromTx) {
      const { data, to: contractAddress, from: userAddress } = txParams;
      const transactionData = parseStandardTokenTransactionData(data);
      // Sometimes the tokenId value is parsed as "_value" param. Not seeing this often any more, but still occasionally:
      // i.e. call approve() on BAYC contract - https://etherscan.io/token/0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d#writeContract, and tokenId shows up as _value,
      // not sure why since it doesn't match the ERC721 ABI spec we use to parse these transactions - https://github.com/MetaMask/metamask-eth-abis/blob/d0474308a288f9252597b7c93a3a8deaad19e1b2/src/abis/abiERC721.ts#L62.
      const transactionDataTokenId =
        getTokenIdParam(transactionData) ?? getTokenValueParam(transactionData);

      // check if its a known NFT
      const knownNft = allNfts?.[userAddress]?.[chainId]?.find(
        ({ address, tokenId }) =>
          isEqualCaseInsensitive(address, contractAddress) &&
          tokenId === transactionDataTokenId,
      );

      // if it is we check and update ownership status.
      if (knownNft) {
        this.nftController.checkAndUpdateSingleNftOwnershipStatus(
          knownNft,
          false,
          // TODO add networkClientId once it is available in the transactionMeta
          // the chainId previously passed here didn't actually allow us to check for ownership on a non globally selected network
          // because the check would use the provider for the globally selected network, not the chainId passed here.
          { userAddress },
        );
      }
    } else {
      // Else if contract interaction we will parse the logs

      const allNftTransferLog = txReceiptLogs.map((txReceiptLog) => {
        const isERC1155NftTransfer =
          txReceiptLog.topics &&
          txReceiptLog.topics[0] === TRANSFER_SINFLE_LOG_TOPIC_HASH;
        const isERC721NftTransfer =
          txReceiptLog.topics &&
          txReceiptLog.topics[0] === TOKEN_TRANSFER_LOG_TOPIC_HASH;
        let isTransferToSelectedAddress;

        if (isERC1155NftTransfer) {
          isTransferToSelectedAddress =
            txReceiptLog.topics &&
            txReceiptLog.topics[3] &&
            txReceiptLog.topics[3].match(selectedAddress?.slice(2));
        }

        if (isERC721NftTransfer) {
          isTransferToSelectedAddress =
            txReceiptLog.topics &&
            txReceiptLog.topics[2] &&
            txReceiptLog.topics[2].match(selectedAddress?.slice(2));
        }

        return {
          isERC1155NftTransfer,
          isERC721NftTransfer,
          isTransferToSelectedAddress,
          ...txReceiptLog,
        };
      });
      if (allNftTransferLog.length !== 0) {
        const allNftParsedLog = [];
        allNftTransferLog.forEach((singleLog) => {
          if (
            singleLog.isTransferToSelectedAddress &&
            (singleLog.isERC1155NftTransfer || singleLog.isERC721NftTransfer)
          ) {
            let iface;
            if (singleLog.isERC1155NftTransfer) {
              iface = new Interface(abiERC1155);
            } else {
              iface = new Interface(abiERC721);
            }
            try {
              const parsedLog = iface.parseLog({
                data: singleLog.data,
                topics: singleLog.topics,
              });
              allNftParsedLog.push({
                contract: singleLog.address,
                ...parsedLog,
              });
            } catch (err) {
              // ignore
            }
          }
        });
        // Filter known nfts and new Nfts
        const knownNFTs = [];
        const newNFTs = [];
        allNftParsedLog.forEach((single) => {
          const tokenIdFromLog = getTokenIdParam(single);
          const existingNft = allNfts?.[selectedAddress]?.[chainId]?.find(
            ({ address, tokenId }) => {
              return (
                isEqualCaseInsensitive(address, single.contract) &&
                tokenId === tokenIdFromLog
              );
            },
          );
          if (existingNft) {
            knownNFTs.push(existingNft);
          } else {
            newNFTs.push({
              tokenId: tokenIdFromLog,
              ...single,
            });
          }
        });
        // For known nfts only refresh ownership
        const refreshOwnershipNFts = knownNFTs.map(async (singleNft) => {
          return this.nftController.checkAndUpdateSingleNftOwnershipStatus(
            singleNft,
            false,
            // TODO add networkClientId once it is available in the transactionMeta
            // the chainId previously passed here didn't actually allow us to check for ownership on a non globally selected network
            // because the check would use the provider for the globally selected network, not the chainId passed here.
            { selectedAddress },
          );
        });
        await Promise.allSettled(refreshOwnershipNFts);
        // For new nfts, add them to state
        const addNftPromises = newNFTs.map(async (singleNft) => {
          return this.nftController.addNft(
            singleNft.contract,
            singleNft.tokenId,
          );
        });
        await Promise.allSettled(addNftPromises);
      }
    }
  }

  _trackTransactionFailure(transactionMeta) {
    const { txReceipt } = transactionMeta;
    const metamaskState = this.getState();

    if (!txReceipt || txReceipt.status !== '0x0') {
      return;
    }

    this.metaMetricsController.trackEvent(
      {
        event: 'Tx Status Update: On-Chain Failure',
        category: MetaMetricsEventCategory.Background,
        properties: {
          action: 'Transactions',
          errorMessage: transactionMeta.simulationFails?.reason,
          numberOfTokens: metamaskState.tokens.length,
          numberOfAccounts: Object.keys(metamaskState.accounts).length,
        },
      },
      {
        matomoEvent: true,
      },
    );
  }

  _onUserOperationAdded(userOperationMeta) {
    const transactionMeta = this.txController.state.transactions.find(
      (tx) => tx.id === userOperationMeta.id,
    );

    if (!transactionMeta) {
      return;
    }

    if (transactionMeta.type === TransactionType.swap) {
      this.controllerMessenger.publish(
        'TransactionController:transactionNewSwap',
        { transactionMeta },
      );
    } else if (transactionMeta.type === TransactionType.swapApproval) {
      this.controllerMessenger.publish(
        'TransactionController:transactionNewSwapApproval',
        { transactionMeta },
      );
    }
  }

  _onUserOperationTransactionUpdated(transactionMeta) {
    const updatedTransactionMeta = {
      ...transactionMeta,
      txParams: {
        ...transactionMeta.txParams,
        from: this.accountsController.getSelectedAccount().address,
      },
    };

    const transactionExists = this.txController.state.transactions.some(
      (tx) => tx.id === updatedTransactionMeta.id,
    );

    if (!transactionExists) {
      this.txController.update((state) => {
        state.transactions.push(updatedTransactionMeta);
      });
    }

    this.txController.updateTransaction(
      updatedTransactionMeta,
      'Generated from user operation',
    );

    this.controllerMessenger.publish(
      'TransactionController:transactionStatusUpdated',
      { transactionMeta: updatedTransactionMeta },
    );
  }

  _getMetaMaskState() {
    return {
      metamask: this.getState(),
    };
  }

  _getConfigForRemoteFeatureFlagRequest() {
    const distribution =
      buildTypeMappingForRemoteFeatureFlag[process.env.METAMASK_BUILD_TYPE] ||
      DistributionType.Main;
    const environment =
      environmentMappingForRemoteFeatureFlag[
        process.env.METAMASK_ENVIRONMENT
      ] || EnvironmentType.Development;
    return { distribution, environment };
  }

  /**
   * Select a hardware wallet device and execute a
   * callback with the keyring for that device.
   *
   * Note that KeyringController state is not updated before
   * the end of the callback execution, and calls to KeyringController
   * methods within the callback can lead to deadlocks.
   *
   * @param {object} options - The options for the device
   * @param {string} options.name - The device name to select
   * @param {string} options.hdPath - An optional hd path to be set on the device
   * keyring
   * @param {*} callback - The callback to execute with the keyring
   * @returns {*} The result of the callback
   */
  async #withKeyringForDevice(options, callback) {
    const keyringOverrides = this.opts.overrides?.keyrings;
    let keyringType = null;
    switch (options.name) {
      case HardwareDeviceNames.trezor:
      case HardwareDeviceNames.oneKey:
        keyringType = keyringOverrides?.trezor?.type || TrezorKeyring.type;
        break;
      case HardwareDeviceNames.ledger:
        keyringType = keyringOverrides?.ledger?.type || LedgerKeyring.type;
        break;
      case HardwareDeviceNames.qr:
        keyringType = QRHardwareKeyring.type;
        break;
      case HardwareDeviceNames.lattice:
        keyringType = keyringOverrides?.lattice?.type || LatticeKeyring.type;
        break;
      default:
        throw new Error(
          'MetamaskController:#withKeyringForDevice - Unknown device',
        );
    }

    return this.keyringController.withKeyring(
      { type: keyringType },
      async (keyring) => {
        if (options.hdPath && keyring.setHdPath) {
          keyring.setHdPath(options.hdPath);
        }

        if (options.name === HardwareDeviceNames.lattice) {
          keyring.appName = 'MetaMask';
        }

        if (
          options.name === HardwareDeviceNames.trezor ||
          options.name === HardwareDeviceNames.oneKey
        ) {
          const model = keyring.getModel();
          this.appStateController.setTrezorModel(model);
        }

        keyring.network = getProviderConfig({
          metamask: this.networkController.state,
        }).type;

        return await callback(keyring);
      },
      {
        createIfMissing: true,
      },
    );
  }

  #checkTokenListPolling(currentState, previousState) {
    const previousEnabled = this.#isTokenListPollingRequired(previousState);
    const newEnabled = this.#isTokenListPollingRequired(currentState);

    if (previousEnabled === newEnabled) {
      return;
    }

    this.tokenListController.updatePreventPollingOnNetworkRestart(!newEnabled);
  }

  #isTokenListPollingRequired(preferencesControllerState) {
    const { useTokenDetection, useTransactionSimulations, preferences } =
      preferencesControllerState ?? {};

    const { petnamesEnabled } = preferences ?? {};

    return useTokenDetection || petnamesEnabled || useTransactionSimulations;
  }

  /**
   * @deprecated Avoid new references to the global network.
   * Will be removed once multi-chain support is fully implemented.
   * @returns {string} The chain ID of the currently selected network.
   */
  #getGlobalChainId() {
    const globalNetworkClientId = this.#getGlobalNetworkClientId();

    const globalNetworkClient = this.networkController.getNetworkClientById(
      globalNetworkClientId,
    );

    return globalNetworkClient.configuration.chainId;
  }

  /**
   * @deprecated Avoid new references to the global network.
   * Will be removed once multi-chain support is fully implemented.
   * @returns {string} The network client ID of the currently selected network client.
   */
  #getGlobalNetworkClientId() {
    return this.networkController.state.selectedNetworkClientId;
  }

  #initControllers({ existingControllers, initFunctions, initState }) {
    const initRequest = {
      getFlatState: this.getState.bind(this),
      getGlobalChainId: this.#getGlobalChainId.bind(this),
      getPermittedAccounts: this.getPermittedAccounts.bind(this),
      getProvider: () => this.provider,
      getStateUI: this._getMetaMaskState.bind(this),
      getTransactionMetricsRequest:
        this.getTransactionMetricsRequest.bind(this),
      offscreenPromise: this.offscreenPromise,
      persistedState: initState,
      removeAllConnections: this.removeAllConnections.bind(this),
      setupUntrustedCommunicationEip1193:
        this.setupUntrustedCommunicationEip1193.bind(this),
      showNotification: this.platform._showNotification,
    };

    return initControllers({
      baseControllerMessenger: this.controllerMessenger,
      existingControllers,
      initFunctions,
      initRequest,
    });
  }
}
