// What the API console may send and what it may not, decided once for every operation of the frozen description of the
// panel (ADR 0046). The lists are explicit, not guessed from names: a test fails the build when an operation listed
// here is not in the description, and another when the description is replaced by a release that has GET operations
// nobody has judged (they would be offered as `open`, so the test counts them).

/**
 * - `open`: reads the objects of the panel itself (nodes, hosts, profiles, squads, templates, settings, billing,
 *   system, aggregate statistics). Allowed with `panel:console`.
 * - `user_data`: reads something about the people who use the panel: users, their devices, subscriptions, requests,
 *   connections, usage. Off unless the installation says `SW_PANEL_CONSOLE_USER_DATA=true`, and then needs
 *   `vault:reveal` and a fresh second factor.
 * - `blocked`: never sent, for the reason it names.
 * - `write`: not a GET. Listed, greyed, never sent in this slice (writes arrive with the approvals of phase 7).
 */
export type ConsoleAvailability = 'open' | 'user_data' | 'blocked' | 'write';

export type ConsoleBlockedReason =
  /** The answer is a credential or a link that works as one (keys, subscription content, connection keys). */
  | 'secret_material'
  /** A GET that changes state on the panel (it creates a challenge that waits for an answer). */
  | 'side_effect';

/** GET operations that are refused outright. */
export const BLOCKED_OPERATIONS: Readonly<Record<string, ConsoleBlockedReason>> = {
  // A registration or authentication challenge is created on the panel by asking for it: a GET with a side effect.
  PasskeyController_passkeyRegistrationOptions: 'side_effect',
  AuthController_passkeyAuthenticationOptions: 'side_effect',
  // The secret key a node is installed with (certificates and key of the panel's authority).
  KeygenController_generateKey: 'secret_material',
  // Thirty fresh X25519 key pairs, private halves included: nothing to explore, only keys to leak.
  SystemController_getX25519Keypairs: 'secret_material',
  // The links that connect a client to the fleet, with the client's identity in them, and the subscription body itself
  // (not JSON, and a link list per user).
  SubscriptionsController_getConnectionKeysByUserId: 'secret_material',
  SubscriptionController_getSubscription: 'secret_material',
  SubscriptionController_getSubscriptionByClientType: 'secret_material',
};

/** GET operations whose answer is about the people who use the panel. */
export const USER_DATA_OPERATIONS: ReadonlySet<string> = new Set([
  // Users.
  'UsersController_getUsers',
  'UsersController_getUsersStream',
  'UsersController_getUserById',
  'UsersController_getUserByShortUuid',
  'UsersController_getUserByUsername',
  'UsersController_getUserAccessibleNodes',
  'UsersController_getUserSubscriptionRequestHistory',
  'MetadataController_getUserMetadata',
  // Subscriptions: who has one, what is in it.
  'SubscriptionController_getSubscriptionInfoByShortUuid',
  'SubscriptionsController_getAllSubscriptions',
  'SubscriptionsController_getSubscriptionByUsername',
  'SubscriptionsController_getSubscriptionByShortUuidProtected',
  'SubscriptionsController_getSubscriptionByUuid',
  'SubscriptionsController_getRawSubscriptionByShortUuid',
  'SubscriptionsController_getSubpageConfigByShortUuid',
  // Devices and requests: identifiers of devices, addresses and agents of people.
  'HwidUserDevicesController_getAllUsers',
  'HwidUserDevicesController_getTopUsersByHwidDevices',
  'HwidUserDevicesController_getUserHwidDevices',
  'UserSubscriptionRequestHistoryController_getSubscriptionRequestHistory',
  // Usage of named users, and who is connected from where.
  'InternalSquadController_getInternalSquadUsage',
  'InternalSquadStatsController_getInternalSquadUsage',
  'InternalSquadStatsController_getInternalSquadUserUsage',
  'BandwidthStatsNodesController_getStatsNodeUsersUsage',
  'BandwidthStatsUsersController_getStatsNodesUsage',
  'ConnectionsController_connectionsByUserResult',
  'ConnectionsController_connectionsByNodeResult',
  // Reports name the user and the address of a torrent request.
  'TorrentBlockerReportsController_getTorrentBlockerReports',
  'TorrentBlockerReportsController_getTorrentBlockerReportsStats',
]);
