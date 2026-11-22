import { z } from 'zod';

import { ServerNameSchema, ServerTagSchema } from './servers.js';

/**
 * Baseline checks (ADR 0045): a baseline is a document that lists what a healthy server looks like, the observations
 * that find it out come from a closed catalogue of read-only measurements, and a run compares the two.
 *
 * Everything in this file is data and rules about data: the catalogue of observation kinds (what each one measures,
 * which parameters it takes, which fields it reports), the comparators, the shape of a baseline document with its
 * semantic validation, and the views the API sends. The script that makes the observations on a server, the parser of its
 * output and the evaluation live in the API (`apps/api/src/baseline`).
 */

// ---- The catalogue of observations ---------------------------------------------------------------------------------

/** What a field of an observation holds. A `list` is a list of short strings. */
export const OBSERVATION_FIELD_TYPES = ['string', 'number', 'boolean', 'list'] as const;
export type ObservationFieldType = (typeof OBSERVATION_FIELD_TYPES)[number];

export interface ObservationFieldDef {
  readonly name: string;
  readonly type: ObservationFieldType;
  readonly description: string;
  /**
   * A list that the server may not be able to observe at all (it needs root): it is null when the script did not
   * look and an empty list when it looked and found nothing. Every other list is empty when nothing was found.
   */
  readonly optional?: true;
}

interface ParamBase {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
}
export type ObservationParamDef =
  | (ParamBase & {
      readonly type: 'string';
      /** The whole value must match (JavaScript syntax). The script never sees a value that does not. */
      readonly pattern: string;
      readonly maxLength: number;
      readonly default?: string;
    })
  | (ParamBase & {
      readonly type: 'integer';
      readonly min: number;
      readonly max: number;
      readonly default?: number;
    })
  | (ParamBase & {
      readonly type: 'enum';
      readonly options: readonly string[];
      readonly default?: string;
    });

export interface ObservationKindDef {
  /** `domain.name`, lower case; the same text names the shell function on the server (dots become underscores). */
  readonly kind: string;
  readonly title: string;
  readonly description: string;
  /** Needs root to see everything: without root (no sudo) the observation answers `denied` and the check is `error`. */
  readonly needsRoot: boolean;
  /**
   * The boolean field that says whether the thing observed is there at all (`exists`, `installed`). When it is false the
   * other fields are not reported, and a check on one of them is a miss (`fail` or `warn` by its severity), not an
   * `error`: a container that does not exist is not "could not be observed".
   */
  readonly presence?: 'exists' | 'installed';
  readonly params: readonly ObservationParamDef[];
  readonly fields: readonly ObservationFieldDef[];
}

const F = (
  name: string,
  type: ObservationFieldType,
  description: string,
  optional?: true,
): ObservationFieldDef => ({ name, type, description, ...(optional ? { optional } : {}) });

/** An absolute path of plain characters: no space, quote or shell syntax, no `..`. */
export const OBSERVATION_PATH_PATTERN = '^/(?:[A-Za-z0-9._@+=,:-]+/?)*$';
const PATH_PARAM = (description: string, def?: string): ObservationParamDef => ({
  name: 'path',
  type: 'string',
  required: def === undefined,
  pattern: OBSERVATION_PATH_PATTERN,
  maxLength: 200,
  ...(def === undefined ? {} : { default: def }),
  description,
});

/**
 * The closed catalogue. Every kind is a small fixed shell fragment in `observe.sh`; a kind reports named fields, and
 * a check picks one. A parameter reaches the fragment as data (checked here and again on the server, never part of a
 * command line) and none of the kinds writes anything, starts anything or sends a secret anywhere.
 */
export const OBSERVATION_KINDS: readonly ObservationKindDef[] = [
  {
    kind: 'os.release',
    title: 'Operating system',
    description: 'The distribution and its release, from /etc/os-release.',
    needsRoot: false,
    params: [],
    fields: [
      F('id', 'string', 'The distribution id: ubuntu, debian, ...'),
      F('versionId', 'string', 'The release number, for example 24.04 or 12.'),
      F('name', 'string', 'The distribution name.'),
      F('codename', 'string', 'The release code name, for example noble.'),
      F('prettyName', 'string', 'The text a person would read.'),
    ],
  },
  {
    kind: 'kernel',
    title: 'Kernel and reboot',
    description:
      'The running kernel, the newest installed one (Debian family) and whether a reboot is pending.',
    needsRoot: false,
    params: [],
    fields: [
      F('running', 'string', 'The running kernel release (uname -r).'),
      F(
        'latestInstalled',
        'string',
        'The newest installed kernel image; empty when it is unknown.',
      ),
      F('behind', 'boolean', 'A newer kernel is installed than the one that runs.'),
      F('rebootRequired', 'boolean', 'The system asks for a reboot (/var/run/reboot-required).'),
      F('rebootPackages', 'list', 'The packages that asked for the reboot.'),
    ],
  },
  {
    kind: 'uptime',
    title: 'Uptime',
    description: 'How long the machine has been running.',
    needsRoot: false,
    params: [],
    fields: [F('seconds', 'number', 'Seconds since boot.')],
  },
  {
    kind: 'time.sync',
    title: 'Time synchronisation',
    description:
      'Whether the clock is kept in step, by which service, and how far it is from true time (chrony) and from the clock of this server.',
    needsRoot: false,
    params: [],
    fields: [
      F('synchronized', 'boolean', 'The system clock is synchronised (timedatectl).'),
      F('service', 'string', 'The active time service: chrony, systemd-timesyncd, ntpd or none.'),
      F('timezone', 'string', 'The time zone.'),
      F('offsetSeconds', 'number', 'Offset from NTP time in seconds, absolute (chrony only).'),
      F(
        'skewSeconds',
        'number',
        'The difference between the clock of the server and the clock of this Swellwright server, absolute, in seconds.',
      ),
    ],
  },
  {
    kind: 'disk.usage',
    title: 'Disk space',
    description: 'Space and inodes of the filesystem that holds a path.',
    needsRoot: false,
    params: [PATH_PARAM('A path on the filesystem to measure.', '/')],
    fields: [
      F('mountpoint', 'string', 'Where the filesystem is mounted.'),
      F('usedPercent', 'number', 'Space used, in percent.'),
      F('availableMiB', 'number', 'Space available, in MiB.'),
      F('inodeUsedPercent', 'number', 'Inodes used, in percent (0 when the filesystem has none).'),
    ],
  },
  {
    kind: 'memory',
    title: 'Memory and swap',
    description: 'Memory and swap, from /proc/meminfo.',
    needsRoot: false,
    params: [],
    fields: [
      F('totalMiB', 'number', 'Memory in MiB.'),
      F('availableMiB', 'number', 'Memory available without swapping, in MiB.'),
      F('availablePercent', 'number', 'Memory available, in percent of the total.'),
      F('swapTotalMiB', 'number', 'Swap in MiB.'),
      F('swapUsedPercent', 'number', 'Swap used, in percent (0 without swap).'),
    ],
  },
  {
    kind: 'updates.pending',
    title: 'Pending updates',
    description:
      'Packages that could be upgraded now, from the package lists already on the disk (nothing is fetched), and how old those lists are. Debian family.',
    needsRoot: false,
    params: [],
    fields: [
      F('manager', 'string', 'The package manager: apt, or none.'),
      F('upgradable', 'number', 'Packages with a newer version.'),
      F('security', 'number', 'Of those, the ones that come from a security pocket.'),
      F(
        'listAgeSeconds',
        'number',
        'Age of the package lists; large when they were never refreshed.',
      ),
    ],
  },
  {
    kind: 'updates.auto',
    title: 'Automatic updates',
    description: 'Whether unattended-upgrades is installed and switched on.',
    needsRoot: false,
    params: [],
    fields: [
      F('installed', 'boolean', 'The unattended-upgrades package is installed.'),
      F(
        'enabled',
        'boolean',
        'The daily unattended upgrade is switched on in the apt configuration.',
      ),
      F('timerActive', 'boolean', 'The apt-daily-upgrade timer is active.'),
    ],
  },
  {
    kind: 'systemd.failed',
    title: 'Failed systemd units',
    description: 'The state of systemd and the units that failed.',
    needsRoot: false,
    params: [],
    fields: [
      F('state', 'string', 'running, degraded, maintenance, ... or unknown.'),
      F('failedCount', 'number', 'How many units are in the failed state.'),
      F('units', 'list', 'The names of the failed units (at most 20).'),
    ],
  },
  {
    kind: 'service.state',
    title: 'A systemd unit',
    description: 'Whether one unit exists, is active and is enabled.',
    needsRoot: false,
    presence: 'exists',
    params: [
      {
        name: 'unit',
        type: 'string',
        required: true,
        pattern:
          '^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,100}\\.(?:service|socket|timer|path|mount|target)$',
        maxLength: 110,
        description: 'The full unit name, for example fail2ban.service.',
      },
    ],
    fields: [
      F('exists', 'boolean', 'systemd knows the unit.'),
      F('active', 'string', 'active, inactive, failed, activating, ... or unknown.'),
      F('enabled', 'string', 'enabled, disabled, static, masked, ... or unknown.'),
    ],
  },
  {
    kind: 'port.listener',
    title: 'A listening port',
    description: 'Whether something listens on a port, on which addresses and which program.',
    needsRoot: true,
    params: [
      {
        name: 'port',
        type: 'integer',
        required: true,
        min: 1,
        max: 65_535,
        description: 'The port.',
      },
      {
        name: 'proto',
        type: 'enum',
        required: false,
        options: ['tcp', 'udp'],
        default: 'tcp',
        description: 'The protocol.',
      },
    ],
    fields: [
      F('listening', 'boolean', 'Something listens on the port.'),
      F('publicly', 'boolean', 'It listens on an address other than loopback.'),
      F('addresses', 'list', 'The addresses it listens on.'),
      F('processes', 'list', 'The programs that hold the sockets (root sees them all).'),
    ],
  },
  {
    kind: 'ports.public',
    title: 'Publicly listening ports',
    description: 'Every port that listens on an address other than loopback.',
    needsRoot: false,
    params: [],
    fields: [
      F('ports', 'list', 'Entries like tcp/443 and udp/53, sorted, each once.'),
      F('count', 'number', 'How many entries.'),
    ],
  },
  {
    kind: 'ufw.status',
    title: 'UFW firewall',
    description: 'Whether UFW is installed and active, its default policy and its rules.',
    needsRoot: true,
    presence: 'installed',
    params: [],
    fields: [
      F('installed', 'boolean', 'ufw is installed.'),
      F('active', 'boolean', 'UFW is active.'),
      F(
        'defaultIncoming',
        'string',
        'The default policy for incoming traffic: deny, allow, reject.',
      ),
      F('rules', 'list', 'The rules, one per entry, as UFW prints them (at most 200).'),
      F('ruleCount', 'number', 'How many rules.'),
    ],
  },
  {
    kind: 'iptables.chain',
    title: 'An iptables chain',
    description:
      'The rules of one iptables chain, by default the DOCKER-USER chain that Docker leaves for the operator.',
    needsRoot: true,
    presence: 'exists',
    params: [
      {
        name: 'chain',
        type: 'string',
        required: false,
        pattern: '^[A-Za-z][A-Za-z0-9_-]{0,27}$',
        maxLength: 28,
        default: 'DOCKER-USER',
        description: 'The chain.',
      },
    ],
    fields: [
      F('exists', 'boolean', 'The chain exists.'),
      F('ruleCount', 'number', 'How many rules (the policy line is not counted).'),
      F('rules', 'list', 'The rules as iptables -S prints them (at most 100).'),
      F(
        'text',
        'string',
        'All the rules in one text, separated by semicolons, cut at 2000 characters.',
      ),
    ],
  },
  {
    kind: 'fail2ban.status',
    title: 'fail2ban',
    description: 'Whether fail2ban runs, which jails it has and how many addresses are banned now.',
    needsRoot: true,
    presence: 'installed',
    params: [],
    fields: [
      F('installed', 'boolean', 'fail2ban is installed.'),
      F('active', 'boolean', 'The service answers.'),
      F('jails', 'list', 'The names of the jails.'),
      F('bannedCount', 'number', 'Addresses banned now, in all jails.'),
    ],
  },
  {
    kind: 'sshd.effective',
    title: 'Effective sshd settings',
    description:
      'The settings the SSH daemon runs with, as `sshd -T` prints them (lower case). A setting the daemon does not print is empty.',
    needsRoot: true,
    params: [],
    fields: [
      F('port', 'string', 'Port (the first one when there are several).'),
      F('permitrootlogin', 'string', 'yes, no, prohibit-password, forced-commands-only.'),
      F('passwordauthentication', 'string', 'yes or no.'),
      F('pubkeyauthentication', 'string', 'yes or no.'),
      F('kbdinteractiveauthentication', 'string', 'yes or no.'),
      F('permitemptypasswords', 'string', 'yes or no.'),
      F('maxauthtries', 'string', 'Failed attempts allowed per connection.'),
      F('logingracetime', 'string', 'Seconds to log in.'),
      F('x11forwarding', 'string', 'yes or no.'),
      F('usepam', 'string', 'yes or no.'),
      F('allowusers', 'string', 'The AllowUsers list, space separated.'),
      F('allowgroups', 'string', 'The AllowGroups list, space separated.'),
      F('authenticationmethods', 'string', 'The required authentication methods.'),
      F('clientaliveinterval', 'string', 'Seconds between keepalive messages.'),
    ],
  },
  {
    kind: 'ssh.keys',
    title: 'Authorized SSH keys',
    description:
      'The fingerprints (never the keys) in ~/.ssh/authorized_keys of every account that can log in and of root.',
    needsRoot: true,
    params: [],
    fields: [
      F('keys', 'list', 'One entry per key: "<account> <fingerprint> <type>".'),
      F('total', 'number', 'How many keys.'),
      F('accounts', 'list', 'The accounts that have at least one key.'),
      F('invalid', 'number', 'Lines that are not a key.'),
    ],
  },
  {
    kind: 'sudoers',
    title: 'sudoers',
    description:
      'Whether sudo is configured, which drop-in files there are and who may use sudo without a password.',
    needsRoot: true,
    params: [],
    fields: [
      F('present', 'boolean', '/etc/sudoers exists.'),
      F('dropIns', 'list', 'The files of /etc/sudoers.d.'),
      F('nopasswd', 'list', 'The users and groups that have a NOPASSWD rule.'),
    ],
  },
  {
    kind: 'users.login',
    title: 'Accounts that can log in',
    description:
      'Accounts with a real login shell, accounts with user id 0, and accounts without a password.',
    needsRoot: false,
    params: [],
    fields: [
      F('accounts', 'list', 'The accounts with a login shell, as "<name>:<uid>".'),
      F('count', 'number', 'How many.'),
      F('uidZero', 'list', 'The accounts with user id 0.'),
      F(
        'emptyPassword',
        'list',
        'The accounts whose password is empty (needs root; null without it).',
        true,
      ),
    ],
  },
  {
    kind: 'sysctl.value',
    title: 'A kernel setting',
    description: 'The value of one sysctl key, from /proc/sys.',
    needsRoot: false,
    presence: 'exists',
    params: [
      {
        name: 'key',
        type: 'string',
        required: true,
        pattern: '^[a-z][a-z0-9_-]*(?:\\.[a-z0-9_-]+){1,6}$',
        maxLength: 100,
        description: 'The key, for example net.ipv4.tcp_congestion_control.',
      },
    ],
    fields: [
      F('exists', 'boolean', 'The key exists.'),
      F('value', 'string', 'Its value, with white space made one space.'),
    ],
  },
  {
    kind: 'docker.engine',
    title: 'Docker',
    description:
      'Whether Docker is installed and running, its version and how many containers there are.',
    needsRoot: true,
    presence: 'installed',
    params: [],
    fields: [
      F('installed', 'boolean', 'The docker command exists.'),
      F('running', 'boolean', 'The daemon answers.'),
      F('version', 'string', 'The server version.'),
      F('composeVersion', 'string', 'The compose plugin version, empty when it is not installed.'),
      F('containers', 'number', 'Containers, running or not.'),
      F('runningContainers', 'number', 'Containers that run.'),
    ],
  },
  {
    kind: 'docker.container',
    title: 'A container',
    description:
      'One container: its state, image, restart policy and health, the names (never the values) of its environment variables and the value of a few that are not secret.',
    needsRoot: true,
    presence: 'exists',
    params: [
      {
        name: 'name',
        type: 'string',
        required: true,
        pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$',
        maxLength: 63,
        description: 'The container name.',
      },
    ],
    fields: [
      F('exists', 'boolean', 'The container exists.'),
      F('state', 'string', 'running, exited, restarting, created, ... '),
      F('image', 'string', 'The image reference the container was made from.'),
      F('tag', 'string', 'The tag of that reference; empty when it has none or names a digest.'),
      F('imageId', 'string', 'The id of the image (a digest).'),
      F('restartPolicy', 'string', 'no, always, unless-stopped, on-failure.'),
      F('health', 'string', 'The health state, or none.'),
      F('uptimeSeconds', 'number', 'Seconds since it started (0 when it does not run).'),
      F('envNames', 'list', 'The names of its environment variables, never the values.'),
      F(
        'envFlags',
        'list',
        'NAME=value for the variables SNI_VERIFICATION, NODE_PORT, NODE_ENV and TZ when it sets them; no other value is read.',
      ),
    ],
  },
  {
    kind: 'nginx.config',
    title: 'nginx',
    description:
      'Whether nginx is installed and active, whether its configuration is valid and which sites are enabled.',
    needsRoot: true,
    presence: 'installed',
    params: [],
    fields: [
      F('installed', 'boolean', 'nginx is installed.'),
      F('active', 'boolean', 'The service is active.'),
      F('valid', 'boolean', '`nginx -t` accepts the configuration.'),
      F('version', 'string', 'The version.'),
      F('enabledSites', 'list', 'The files of /etc/nginx/sites-enabled.'),
    ],
  },
  {
    kind: 'haproxy.config',
    title: 'HAProxy',
    description:
      'Whether HAProxy is installed and active, its configuration is valid, its frontends and their default backends.',
    needsRoot: true,
    presence: 'installed',
    params: [],
    fields: [
      F('installed', 'boolean', 'haproxy is installed.'),
      F('active', 'boolean', 'The service is active.'),
      F('valid', 'boolean', '`haproxy -c` accepts /etc/haproxy/haproxy.cfg.'),
      F('version', 'string', 'The version.'),
      F('frontends', 'list', 'The names of the frontends.'),
      F('defaultBackends', 'list', 'The default_backend lines, as "<backend>".'),
    ],
  },
  {
    kind: 'cert.file',
    title: 'A certificate file',
    description:
      'A PEM certificate: its subject, issuer, days left and the mode and owner of the file.',
    needsRoot: true,
    presence: 'exists',
    params: [PATH_PARAM('The certificate file.')],
    fields: [
      F('exists', 'boolean', 'The file exists.'),
      F('subjectCn', 'string', 'The common name of the subject.'),
      F('issuerCn', 'string', 'The common name of the issuer.'),
      F('selfSigned', 'boolean', 'Subject and issuer are the same.'),
      F('daysLeft', 'number', 'Days until it expires (negative when it has expired).'),
      F('mode', 'string', 'The file mode in octal.'),
      F('owner', 'string', 'The owner of the file.'),
      F('group', 'string', 'The group of the file.'),
    ],
  },
  {
    kind: 'file.stat',
    title: 'A file or directory',
    description: 'Existence, type, mode, owner and age of a path.',
    needsRoot: false,
    presence: 'exists',
    params: [PATH_PARAM('The path.')],
    fields: [
      F('exists', 'boolean', 'The path exists.'),
      F('type', 'string', 'file, dir, link or other.'),
      F('mode', 'string', 'The mode in octal.'),
      F('owner', 'string', 'The owner.'),
      F('group', 'string', 'The group.'),
      F('size', 'number', 'Size in bytes.'),
      F('ageSeconds', 'number', 'Seconds since the last change.'),
    ],
  },
  {
    kind: 'file.hash',
    title: 'The hash of a file',
    description:
      'The SHA-256 of a file (only the hash, never the content). Files over 8 MiB are not read.',
    needsRoot: true,
    presence: 'exists',
    params: [PATH_PARAM('The file.')],
    fields: [
      F('exists', 'boolean', 'The file exists and is a regular file.'),
      F('sha256', 'string', 'The hash in lower-case hex; empty when it was not read.'),
      F('size', 'number', 'Size in bytes.'),
    ],
  },
  {
    kind: 'certsync.account',
    title: 'The certificate receiver account',
    description:
      'The account that receives certificates: whether it exists and whether its key is restricted to a forced rsync command.',
    needsRoot: true,
    presence: 'exists',
    params: [
      {
        name: 'user',
        type: 'string',
        required: false,
        pattern: '^[a-z_][a-z0-9_-]{0,31}$',
        maxLength: 32,
        default: 'certsync',
        description: 'The account.',
      },
    ],
    fields: [
      F('exists', 'boolean', 'The account exists.'),
      F('keyCount', 'number', 'Keys in its authorized_keys.'),
      F('restricted', 'boolean', 'Every key has `restrict` and a forced command (`command=`).'),
      F('command', 'string', 'The forced command of the first key.'),
      F('shell', 'string', 'The login shell.'),
    ],
  },
  {
    kind: 'installer.journal',
    title: 'The node installer journal',
    description:
      'What the journal of the node installer says: its version, when it last ran and the result of the last `verify`. Only the journal is read; the installer is not run.',
    needsRoot: true,
    presence: 'exists',
    params: [],
    fields: [
      F('exists', 'boolean', 'The journal exists.'),
      F('version', 'string', 'The installer version of the last run.'),
      F('lastAction', 'string', 'The action of the last run.'),
      F('lastRunAgeSeconds', 'number', 'Seconds since the last run began.'),
      F(
        'verifyAgeSeconds',
        'number',
        'Seconds since the last `verify` or `full` run began (absent when none).',
      ),
      F('verifyOk', 'number', 'Checks of that run that passed.'),
      F('verifyWarn', 'number', 'Checks of that run that warned.'),
      F('verifyFail', 'number', 'Checks of that run that failed.'),
      F('failedChecks', 'list', 'The names of the failed checks of that run.'),
    ],
  },
  {
    kind: 'http.local',
    title: 'A local HTTP probe',
    description:
      'The status code a request to a port of this machine gets (nothing else is read). The request goes to loopback or to the own address of the machine, never further.',
    needsRoot: false,
    params: [
      {
        name: 'port',
        type: 'integer',
        required: true,
        min: 1,
        max: 65_535,
        description: 'The port.',
      },
      {
        name: 'scheme',
        type: 'enum',
        required: false,
        options: ['http', 'https'],
        default: 'http',
        description: 'http or https (the certificate is not verified).',
      },
      {
        name: 'target',
        type: 'enum',
        required: false,
        options: ['loopback', 'self'],
        default: 'loopback',
        description:
          'loopback is 127.0.0.1; self is the first address of the machine on its default route.',
      },
      {
        name: 'sni',
        type: 'string',
        required: false,
        pattern: '^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$',
        maxLength: 253,
        description:
          'The host name to ask for (HTTPS SNI and Host header). Without it the request names the address.',
      },
    ],
    fields: [F('status', 'number', 'The HTTP status code; 0 when nothing answered.')],
  },
  {
    kind: 'dns.self',
    title: 'The own name of the machine',
    description:
      'What the host name of the machine resolves to and whether one of the answers is an address of the machine.',
    needsRoot: false,
    params: [],
    fields: [
      F('name', 'string', 'The fully qualified host name.'),
      F('resolves', 'boolean', 'The name resolves.'),
      F('addresses', 'list', 'The IPv4 addresses it resolves to.'),
      F('local', 'boolean', 'One of them is configured on an interface of this machine.'),
    ],
  },
];

const KIND_BY_NAME = new Map(OBSERVATION_KINDS.map((def) => [def.kind, def]));

export const OBSERVATION_KIND_NAMES = OBSERVATION_KINDS.map((def) => def.kind) as [
  string,
  ...string[],
];

export function observationKind(kind: string): ObservationKindDef | undefined {
  return KIND_BY_NAME.get(kind);
}

export type ObservationParamValue = string | number | boolean;
export type ObservationParams = Readonly<Record<string, ObservationParamValue>>;

/** What is wrong with the parameters of an observation, one sentence each; empty when they are fine. */
export function observationParamIssues(
  def: ObservationKindDef,
  params: ObservationParams,
): string[] {
  const issues: string[] = [];
  const known = new Set(def.params.map((param) => param.name));
  for (const name of Object.keys(params)) {
    if (!known.has(name)) {
      issues.push(
        def.params.length === 0
          ? `"${def.kind}" takes no parameters, "${name}" is not one.`
          : `"${name}" is not a parameter of "${def.kind}" (it takes ${[...known].join(', ')}).`,
      );
    }
  }
  for (const param of def.params) {
    const value = params[param.name];
    if (value === undefined) {
      if (param.required) {
        issues.push(`"${def.kind}" needs the parameter "${param.name}".`);
      }
      continue;
    }
    if (param.type === 'integer') {
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < param.min ||
        value > param.max
      ) {
        issues.push(
          `"${param.name}" must be a whole number from ${String(param.min)} to ${String(param.max)}.`,
        );
      }
    } else if (param.type === 'enum') {
      if (typeof value !== 'string' || !param.options.includes(value)) {
        issues.push(`"${param.name}" must be one of ${param.options.join(', ')}.`);
      }
    } else if (
      typeof value !== 'string' ||
      value.length > param.maxLength ||
      !new RegExp(param.pattern, 'u').test(value) ||
      value.includes('..')
    ) {
      issues.push(`"${param.name}" is not an acceptable value (${param.description})`);
    }
  }
  return issues;
}

/** The value of every parameter, defaults filled in, in the order of the definition. */
export function withParamDefaults(
  def: ObservationKindDef,
  params: ObservationParams,
): Record<string, ObservationParamValue> {
  const out: Record<string, ObservationParamValue> = {};
  for (const param of def.params) {
    const value = params[param.name] ?? param.default;
    if (value !== undefined) {
      out[param.name] = value;
    }
  }
  return out;
}

// ---- Comparators ---------------------------------------------------------------------------------------------------

export const COMPARATORS = [
  'equals',
  'notEquals',
  'in',
  'matches',
  'atLeast',
  'atMost',
  'contains',
  'notContains',
  'absent',
  'present',
  'versionAtLeast',
  'ageLessThan',
] as const;
export type Comparator = (typeof COMPARATORS)[number];

export const COMPARATOR_INFO: Readonly<Record<Comparator, string>> = {
  equals: 'The value is exactly this.',
  notEquals: 'The value is not this.',
  in: 'The value is one of these (for a list: every entry is one of these).',
  matches:
    'The text matches this regular expression (the whole text is searched, `^` and `$` mark line ends).',
  atLeast: 'The number is at least this.',
  atMost: 'The number is at most this.',
  contains: 'The list has this entry (for text: it contains this text).',
  notContains: 'The list does not have this entry (for text: it does not contain this text).',
  absent: 'There is no value: nothing, an empty text or an empty list.',
  present: 'There is a value: not empty.',
  versionAtLeast: 'The version is at least this (numbers compared part by part).',
  ageLessThan: 'The number of seconds is less than this duration (30m, 12h, 7d).',
};

export const DURATION_PATTERN = /^[1-9][0-9]{0,6}[smhd]$/u;
export const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){0,3}$/u;
export const MAX_REGEX_LENGTH = 200;

export function durationSeconds(text: string): number | undefined {
  const match = /^([1-9][0-9]{0,6})([smhd])$/u.exec(text);
  if (!match) {
    return undefined;
  }
  const unit = { s: 1, m: 60, h: 3600, d: 86_400 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return Number(match[1]) * unit;
}

/** A pattern that can be compiled, that is short, and has no group that repeats and is itself repeated. */
export function regexIssue(source: string): string | undefined {
  if (source.length === 0 || source.length > MAX_REGEX_LENGTH) {
    return `The pattern must be 1 to ${String(MAX_REGEX_LENGTH)} characters.`;
  }
  try {
    new RegExp(source, 'mu');
  } catch {
    return 'The pattern is not a valid regular expression.';
  }
  if (/\\[1-9]|\\k</u.test(source)) {
    return 'The pattern must not use back references.';
  }
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/u.test(source)) {
    return 'The pattern repeats a group that repeats; write it without nested repetition.';
  }
  return undefined;
}

const ScalarSchema = z.union([z.string().max(400), z.number(), z.boolean()]);

/** Exactly one of these keys. */
export const ExpectationSchema = z
  .strictObject({
    equals: ScalarSchema.optional(),
    notEquals: ScalarSchema.optional(),
    in: z.array(ScalarSchema).min(1).max(100).optional(),
    matches: z.string().optional(),
    atLeast: z.number().optional(),
    atMost: z.number().optional(),
    contains: z.string().max(400).optional(),
    notContains: z.string().max(400).optional(),
    absent: z.literal(true).optional(),
    present: z.literal(true).optional(),
    versionAtLeast: z.string().optional(),
    ageLessThan: z.string().optional(),
  })
  .refine((expectation) => Object.keys(expectation).length === 1, {
    message: `Give exactly one comparator: ${COMPARATORS.join(', ')}.`,
  })
  .meta({
    id: 'BaselineExpectation',
    description: `What the observed field must be. Exactly one of: ${COMPARATORS.join(', ')}.`,
  });
export type Expectation = z.infer<typeof ExpectationSchema>;

/** The comparator of an expectation and its argument. */
export function comparatorOf(expectation: Expectation): {
  comparator: Comparator;
  argument: unknown;
} {
  for (const comparator of COMPARATORS) {
    if (expectation[comparator] !== undefined) {
      return { comparator, argument: expectation[comparator] };
    }
  }
  throw new Error('An expectation must have a comparator.');
}

// ---- The baseline document -----------------------------------------------------------------------------------------

export const BASELINE_SCHEMA_VERSION = 1;
export const MAX_BASELINE_CHECKS = 300;
export const MAX_BASELINE_SOURCE_BYTES = 256 * 1024;

export const BASELINE_CATEGORIES = [
  'system',
  'updates',
  'time',
  'resources',
  'network',
  'firewall',
  'ssh',
  'accounts',
  'services',
  'docker',
  'node',
  'tls',
  'web',
  'installer',
] as const;
export const BaselineCategorySchema = z.enum(BASELINE_CATEGORIES).meta({ id: 'BaselineCategory' });
export type BaselineCategory = z.infer<typeof BaselineCategorySchema>;

export const BASELINE_SEVERITIES = ['high', 'medium', 'low'] as const;
export const BaselineSeveritySchema = z.enum(BASELINE_SEVERITIES).meta({
  id: 'BaselineSeverity',
  description:
    'What a missed expectation means: `high` is a `fail`, `medium` and `low` are a `warn` (`low` is shown less prominently).',
});
export type BaselineSeverity = z.infer<typeof BaselineSeveritySchema>;

export const CHECK_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;

export const ObserveSchema = z
  .strictObject({
    kind: z.string().max(40),
    params: z.record(z.string().max(32), ScalarSchema).optional(),
    field: z.string().max(40),
  })
  .meta({
    id: 'BaselineObserve',
    description:
      'Which observation to make (a kind of the catalogue, GET /baseline-catalogue), with its parameters, and which of its fields to compare.',
  });
export type Observe = z.infer<typeof ObserveSchema>;

export const BaselineCheckSchema = z
  .strictObject({
    id: z.string().regex(CHECK_ID_PATTERN, {
      message:
        'Use 1 to 64 lower-case letters, digits, dots, dashes or underscores, starting with a letter.',
    }),
    title: z.string().trim().min(1).max(160),
    category: BaselineCategorySchema,
    severity: BaselineSeveritySchema,
    observe: ObserveSchema,
    expect: ExpectationSchema,
    remediationHint: z.string().trim().min(1).max(300).optional(),
  })
  .meta({ id: 'BaselineCheck' });
export type BaselineCheck = z.infer<typeof BaselineCheckSchema>;

/** The type a comparator needs the field to have, or a sentence about what it needs. */
function comparatorProblem(
  comparator: Comparator,
  argument: unknown,
  field: ObservationFieldDef,
): string | undefined {
  const type = field.type;
  switch (comparator) {
    case 'equals':
    case 'notEquals': {
      if (type === 'list') {
        return `"${comparator}" compares one value; "${field.name}" is a list (use contains, in or absent).`;
      }
      const expected = typeof argument;
      return expected === type
        ? undefined
        : `"${field.name}" is ${type === 'boolean' ? 'a boolean' : `a ${type}`}; give ${type === 'boolean' ? 'true or false' : `a ${type}`}.`;
    }
    case 'in': {
      const items = argument as readonly unknown[];
      const want = type === 'list' ? 'string' : type;
      return items.every((item) => typeof item === want)
        ? undefined
        : `"${field.name}" holds ${want === 'string' ? 'text' : want === 'number' ? 'numbers' : 'booleans'}; the list must hold only those.`;
    }
    case 'matches':
      return type === 'string'
        ? (regexIssue(argument as string) ?? undefined)
        : `"matches" works on text; "${field.name}" is ${type === 'list' ? 'a list' : `a ${type}`} (for a list use contains).`;
    case 'atLeast':
    case 'atMost':
      return type === 'number'
        ? undefined
        : `"${comparator}" works on numbers; "${field.name}" is ${type === 'list' ? 'a list' : `a ${type}`}.`;
    case 'contains':
    case 'notContains':
      return type === 'list' || type === 'string'
        ? undefined
        : `"${comparator}" works on lists and text; "${field.name}" is ${type === 'number' ? 'a number' : 'a boolean'}.`;
    case 'absent':
    case 'present':
      return undefined;
    case 'versionAtLeast':
      return type !== 'string'
        ? `"versionAtLeast" works on text; "${field.name}" is ${type === 'list' ? 'a list' : `a ${type}`}.`
        : VERSION_PATTERN.test(argument as string)
          ? undefined
          : 'A version is numbers with dots, for example 24.04 or 3.4.6.';
    case 'ageLessThan':
      return type !== 'number'
        ? `"ageLessThan" works on a number of seconds; "${field.name}" is ${type === 'list' ? 'a list' : `a ${type}`}.`
        : DURATION_PATTERN.test(argument as string)
          ? undefined
          : 'A duration is a number and a unit: 30m, 12h, 7d.';
  }
}

export const BaselineDocumentSchema = z
  .strictObject({
    schema: z.literal(BASELINE_SCHEMA_VERSION),
    description: z.string().trim().max(500).optional(),
    checks: z.array(BaselineCheckSchema).min(1).max(MAX_BASELINE_CHECKS),
  })
  .superRefine((document, context) => {
    const seen = new Map<string, number>();
    document.checks.forEach((check, index) => {
      const at = (...rest: (string | number)[]): (string | number)[] => ['checks', index, ...rest];
      const first = seen.get(check.id);
      if (first !== undefined) {
        context.addIssue({
          code: 'custom',
          path: at('id'),
          message: `The id "${check.id}" is used by check ${String(first + 1)} too.`,
        });
      } else {
        seen.set(check.id, index);
      }
      const def = observationKind(check.observe.kind);
      if (!def) {
        context.addIssue({
          code: 'custom',
          path: at('observe', 'kind'),
          message: `"${check.observe.kind}" is not an observation kind. See GET /baseline-catalogue.`,
        });
        return;
      }
      for (const message of observationParamIssues(def, check.observe.params ?? {})) {
        context.addIssue({ code: 'custom', path: at('observe', 'params'), message });
      }
      const field = def.fields.find((candidate) => candidate.name === check.observe.field);
      if (!field) {
        context.addIssue({
          code: 'custom',
          path: at('observe', 'field'),
          message: `"${def.kind}" has no field "${check.observe.field}" (it has ${def.fields.map((f) => f.name).join(', ')}).`,
        });
        return;
      }
      const { comparator, argument } = comparatorOf(check.expect);
      const problem = comparatorProblem(comparator, argument, field);
      if (problem) {
        context.addIssue({ code: 'custom', path: at('expect', comparator), message: problem });
      }
    });
  })
  .meta({
    id: 'BaselineDocument',
    description:
      'What a healthy server looks like: a list of checks, each an observation of the catalogue and an expectation about one of its fields.',
  });
export type BaselineDocument = z.infer<typeof BaselineDocumentSchema>;

// ---- Results -------------------------------------------------------------------------------------------------------

export const CHECK_STATUSES = ['pass', 'warn', 'fail', 'error', 'skipped'] as const;
export const CheckStatusSchema = z.enum(CHECK_STATUSES).meta({
  id: 'CheckStatus',
  description:
    '`pass`: as expected. `warn` and `fail`: not as expected (by the severity of the check). `error`: it could not be observed (needs root, the tool failed, a time limit). `skipped`: not applicable here.',
});
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const OBSERVATION_STATUSES = ['ok', 'denied', 'error', 'timeout', 'unsupported'] as const;
export const ObservationStatusSchema = z
  .enum(OBSERVATION_STATUSES)
  .meta({ id: 'ObservationStatus' });
export type ObservationStatus = z.infer<typeof ObservationStatusSchema>;

export const CHECK_RUN_STATES = ['queued', 'running', 'completed', 'error'] as const;
export const CheckRunStateSchema = z.enum(CHECK_RUN_STATES).meta({
  id: 'CheckRunState',
  description:
    '`queued` and `running` are going on. `completed`: the server was observed (the results may still fail). `error`: it could not be observed at all (`errorCode` says why).',
});
export type CheckRunState = z.infer<typeof CheckRunStateSchema>;

export const CHECK_TRIGGERS = ['manual', 'scheduled'] as const;
export const CheckTriggerSchema = z.enum(CHECK_TRIGGERS).meta({ id: 'CheckTrigger' });
export type CheckTrigger = z.infer<typeof CheckTriggerSchema>;

/** The value of a field as it is stored and shown. */
export const ObservedValueSchema = z
  .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
  .nullable()
  .meta({
    id: 'ObservedValue',
    description: 'A text, a number, a boolean or a list of texts; null when nothing was observed.',
  });
export type ObservedValue = z.infer<typeof ObservedValueSchema>;

export const CheckResultViewSchema = z
  .object({
    checkId: z.string(),
    title: z.string(),
    category: BaselineCategorySchema,
    severity: BaselineSeveritySchema,
    status: CheckStatusSchema,
    observation: z.object({
      kind: z.string(),
      field: z.string(),
      params: z.record(z.string(), ScalarSchema),
      status: ObservationStatusSchema,
    }),
    observed: ObservedValueSchema,
    expectation: z.object({ comparator: z.enum(COMPARATORS), value: z.unknown() }),
    message: z
      .string()
      .nullable()
      .describe('Why the check did not pass, in one sentence; null when it passed.'),
    remediationHint: z.string().nullable(),
  })
  .meta({ id: 'CheckResultView' });
export type CheckResultView = z.infer<typeof CheckResultViewSchema>;

export const CheckCountsSchema = z
  .object({
    pass: z.number().int().nonnegative(),
    warn: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .meta({ id: 'CheckCounts' });
export type CheckCounts = z.infer<typeof CheckCountsSchema>;

const BaselineRefSchema = z.object({
  id: z.uuid().nullable().describe('Null when the baseline was deleted since.'),
  name: z.string(),
  version: z.number().int().positive(),
  sha256: z.string().describe('SHA-256 of the canonical document that ran.'),
});

const ActorRefSchema = z.object({ id: z.uuid(), name: z.string() });

export const CheckRunSummarySchema = z
  .object({
    id: z.uuid(),
    serverId: z.uuid(),
    serverName: z.string().describe('The name of the server at the time of the run.'),
    baseline: BaselineRefSchema,
    trigger: CheckTriggerSchema,
    state: CheckRunStateSchema,
    queuedAt: z.iso.datetime().describe('When the run was created.'),
    startedAt: z.iso
      .datetime()
      .nullable()
      .describe('When the server was first contacted; null while it waits.'),
    finishedAt: z.iso.datetime().nullable(),
    durationMs: z.number().int().nonnegative().nullable().describe('From the start to the end.'),
    counts: CheckCountsSchema,
    trend: z
      .enum(['better', 'worse', 'same'])
      .nullable()
      .describe(
        'Better or worse than the completed run before it; null for the first completed run and for a run that did not complete.',
      ),
    changedSincePrevious: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        'How many checks changed status since the previous completed run of this server; null for the first.',
      ),
    errorCode: z
      .string()
      .nullable()
      .describe('Why a run could not observe the server (an API error code).'),
    errorMessage: z.string().nullable(),
    startedBy: ActorRefSchema.nullable().describe('Null for a scheduled run.'),
    collectedAs: z
      .enum(['root', 'sudo', 'user'])
      .nullable()
      .describe('With which rights the observations ran. `user` cannot see what needs root.'),
  })
  .meta({ id: 'CheckRunSummary' });
export type CheckRunSummary = z.infer<typeof CheckRunSummarySchema>;

export const CheckRunViewSchema = CheckRunSummarySchema.extend({
  scriptSha256: z.string().nullable().describe('SHA-256 of the observation script that ran.'),
  results: z.array(CheckResultViewSchema),
}).meta({ id: 'CheckRunView' });
export type CheckRunView = z.infer<typeof CheckRunViewSchema>;

export const CheckRunListSchema = z
  .object({ runs: z.array(CheckRunSummarySchema), total: z.number().int().nonnegative() })
  .meta({ id: 'CheckRunList' });
export type CheckRunList = z.infer<typeof CheckRunListSchema>;

export const CheckRunListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().describe('30 by default.'),
  offset: z.coerce.number().int().min(0).optional(),
});

export type CheckRunListQuery = z.infer<typeof CheckRunListQuerySchema>;

export const CheckRunIdParamsSchema = z.object({ id: z.uuid() });

// ---- The drift between two runs -----------------------------------------------------------------------------------

export const DRIFT_CHANGES = ['regressed', 'improved', 'changed', 'added', 'removed'] as const;
export const DriftChangeSchema = z.enum(DRIFT_CHANGES).meta({
  id: 'DriftChange',
  description:
    '`regressed`: the status got worse. `improved`: it got better. `changed`: the status is the same, the observed value is not. `added` and `removed`: the check is in one baseline only.',
});
export type DriftChange = z.infer<typeof DriftChangeSchema>;

const DriftSideSchema = z.object({
  status: CheckStatusSchema,
  observed: ObservedValueSchema,
  message: z.string().nullable(),
});

export const DriftItemSchema = z
  .object({
    checkId: z.string(),
    title: z.string(),
    category: BaselineCategorySchema,
    severity: BaselineSeveritySchema,
    change: DriftChangeSchema,
    from: DriftSideSchema.nullable(),
    to: DriftSideSchema.nullable(),
  })
  .meta({ id: 'DriftItem' });
export type DriftItem = z.infer<typeof DriftItemSchema>;

export const DriftCountsSchema = z
  .object({
    regressed: z.number().int().nonnegative(),
    improved: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
  })
  .meta({ id: 'DriftCounts' });

export const DRIFT_NOTES = [
  'baseline_version_differs',
  'baseline_differs',
  'no_previous_run',
] as const;

export const CheckRunDiffSchema = z
  .object({
    from: CheckRunSummarySchema.nullable().describe(
      'Null when there is no earlier completed run to compare with.',
    ),
    to: CheckRunSummarySchema,
    identical: z
      .boolean()
      .describe('Nothing differs: every check has the same status and the same observed value.'),
    counts: DriftCountsSchema,
    changes: z.array(DriftItemSchema),
    notes: z.array(z.enum(DRIFT_NOTES)),
  })
  .meta({ id: 'CheckRunDiff' });
export type CheckRunDiff = z.infer<typeof CheckRunDiffSchema>;

export const CheckRunDiffQuerySchema = z.object({
  against: z
    .string()
    .regex(/^(?:previous|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u)
    .optional()
    .describe(
      '`previous` (the default): the completed run before this one on the same server. Or the id of a run of the same server.',
    ),
});

// ---- Baseline profiles ---------------------------------------------------------------------------------------------

export const BaselineNameSchema = ServerNameSchema;

export const BaselineVersionInfoSchema = z
  .object({
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    createdBy: ActorRefSchema.nullable(),
    comment: z.string().nullable(),
    sha256: z.string(),
    checkCount: z.number().int().nonnegative(),
  })
  .meta({ id: 'BaselineVersionInfo' });
export type BaselineVersionInfo = z.infer<typeof BaselineVersionInfoSchema>;

export const BaselineAssignmentsSchema = z
  .object({
    servers: z.array(z.object({ id: z.uuid(), name: z.string() })),
    tags: z.array(z.string()),
  })
  .meta({ id: 'BaselineAssignments' });
export type BaselineAssignments = z.infer<typeof BaselineAssignmentsSchema>;

export const BaselineSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    builtIn: z
      .boolean()
      .describe(
        'Shipped with Swellwright: it cannot be changed, but it can be copied and assigned.',
      ),
    currentVersion: z.number().int().positive(),
    checkCount: z.number().int().nonnegative(),
    updatedAt: z.iso.datetime(),
    assignments: BaselineAssignmentsSchema,
    serverCount: z
      .number()
      .int()
      .nonnegative()
      .describe('How many servers use it now (explicitly or by a tag).'),
  })
  .meta({ id: 'BaselineSummary' });
export type BaselineSummary = z.infer<typeof BaselineSummarySchema>;

export const BaselineListSchema = z
  .object({ baselines: z.array(BaselineSummarySchema) })
  .meta({ id: 'BaselineList' });
export type BaselineList = z.infer<typeof BaselineListSchema>;

export const BaselineViewSchema = BaselineSummarySchema.extend({
  version: z.number().int().positive().describe('The version `document` and `source` are of.'),
  document: BaselineDocumentSchema,
  source: z.string().describe('The document as YAML, the text the editor shows.'),
  versions: z.array(BaselineVersionInfoSchema).describe('Newest first.'),
}).meta({ id: 'BaselineView' });
export type BaselineView = z.infer<typeof BaselineViewSchema>;

export const BaselineIdParamsSchema = z.object({ id: z.uuid() });
export const BaselineViewQuerySchema = z.object({
  version: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe('An older version; the current one by default.'),
});

const SourceSchema = z
  .string()
  .min(1)
  .refine((text) => !text.includes('\u0000'), {
    message: 'The text must not contain a NUL character.',
  })
  .refine((text) => new TextEncoder().encode(text).length <= MAX_BASELINE_SOURCE_BYTES, {
    message: `A baseline is at most ${String(MAX_BASELINE_SOURCE_BYTES / 1024)} KiB.`,
  })
  .describe('The document as YAML or JSON text.');

export const CreateBaselineRequestSchema = z
  .object({
    name: BaselineNameSchema,
    description: z.string().trim().min(1).max(300).optional(),
    source: SourceSchema,
    comment: z.string().trim().min(1).max(200).optional(),
  })
  .meta({ id: 'CreateBaselineRequest' });
export type CreateBaselineRequest = z.infer<typeof CreateBaselineRequestSchema>;

export const UpdateBaselineRequestSchema = z
  .object({
    description: z.string().trim().min(1).max(300).nullable().optional(),
    source: SourceSchema.optional(),
    comment: z.string().trim().min(1).max(200).optional(),
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'The version this change was made from; another current version answers 409, so that nobody overwrites a newer one.',
      ),
  })
  .refine((body) => body.source !== undefined || body.description !== undefined, {
    message: 'Change the source or the description.',
  })
  .meta({
    id: 'UpdateBaselineRequest',
    description:
      'A changed document becomes a new version; the old one stays. A built-in baseline cannot be changed (409).',
  });
export type UpdateBaselineRequest = z.infer<typeof UpdateBaselineRequestSchema>;

export const ValidateBaselineRequestSchema = z
  .object({ source: SourceSchema })
  .meta({ id: 'ValidateBaselineRequest' });
export type ValidateBaselineRequest = z.infer<typeof ValidateBaselineRequestSchema>;

export const BaselineIssueSchema = z
  .object({
    path: z
      .string()
      .describe('Where, for example `checks[3].observe.field`; empty for the whole document.'),
    message: z.string(),
    line: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe('1-based line in the source, when it can be told.'),
    column: z.number().int().positive().nullable(),
  })
  .meta({ id: 'BaselineIssue' });
export type BaselineIssue = z.infer<typeof BaselineIssueSchema>;

export const ValidateBaselineResultSchema = z
  .object({
    valid: z.boolean(),
    issues: z.array(BaselineIssueSchema),
    checkCount: z.number().int().nonnegative(),
    categories: z.array(
      z.object({ category: BaselineCategorySchema, checks: z.number().int().nonnegative() }),
    ),
    sha256: z.string().nullable().describe('The hash of the canonical document, when it is valid.'),
  })
  .meta({ id: 'ValidateBaselineResult' });
export type ValidateBaselineResult = z.infer<typeof ValidateBaselineResultSchema>;

export const SetBaselineAssignmentsRequestSchema = z
  .object({
    serverIds: z.array(z.uuid()).max(500),
    tags: z.array(ServerTagSchema).max(50),
  })
  .meta({
    id: 'SetBaselineAssignmentsRequest',
    description:
      'The servers and tags this baseline applies to, replacing what it had. A server or tag that another baseline had is moved here. A server named here uses this baseline whatever its tags say; otherwise the baseline of a tag it carries applies (the first by name when it has several).',
  });
export type SetBaselineAssignmentsRequest = z.infer<typeof SetBaselineAssignmentsRequestSchema>;

export const ObservationCatalogueSchema = z
  .object({
    schemaVersion: z.literal(BASELINE_SCHEMA_VERSION),
    categories: z.array(BaselineCategorySchema),
    comparators: z.array(z.object({ comparator: z.enum(COMPARATORS), description: z.string() })),
    kinds: z.array(
      z.object({
        kind: z.string(),
        title: z.string(),
        description: z.string(),
        needsRoot: z.boolean(),
        presence: z.enum(['exists', 'installed']).optional(),
        params: z.array(
          z.object({
            name: z.string(),
            type: z.enum(['string', 'integer', 'enum']),
            required: z.boolean(),
            description: z.string(),
            default: ScalarSchema.optional(),
            options: z.array(z.string()).optional(),
            min: z.number().optional(),
            max: z.number().optional(),
            pattern: z.string().optional(),
          }),
        ),
        fields: z.array(
          z.object({
            name: z.string(),
            type: z.enum(OBSERVATION_FIELD_TYPES),
            description: z.string(),
          }),
        ),
      }),
    ),
  })
  .meta({
    id: 'ObservationCatalogue',
    description: 'The closed catalogue of read-only observations a baseline may use.',
  });
export type ObservationCatalogue = z.infer<typeof ObservationCatalogueSchema>;

export function observationCatalogue(): ObservationCatalogue {
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    categories: [...BASELINE_CATEGORIES],
    comparators: COMPARATORS.map((comparator) => ({
      comparator,
      description: COMPARATOR_INFO[comparator],
    })),
    kinds: OBSERVATION_KINDS.map((def) => ({
      kind: def.kind,
      title: def.title,
      description: def.description,
      needsRoot: def.needsRoot,
      ...(def.presence === undefined ? {} : { presence: def.presence }),
      params: def.params.map((param) => ({
        name: param.name,
        type: param.type,
        required: param.required,
        description: param.description,
        ...(param.default === undefined ? {} : { default: param.default }),
        ...(param.type === 'enum' ? { options: [...param.options] } : {}),
        ...(param.type === 'integer' ? { min: param.min, max: param.max } : {}),
        ...(param.type === 'string' ? { pattern: param.pattern } : {}),
      })),
      fields: def.fields.map((field) => ({
        name: field.name,
        type: field.type,
        description: field.description,
      })),
    })),
  };
}

// ---- Starting runs, the fleet view ---------------------------------------------------------------------------------

export const StartServerBaselineRunRequestSchema = z
  .object({
    baselineId: z
      .uuid()
      .optional()
      .describe('Check against this baseline instead of the one assigned to the server.'),
  })
  .meta({ id: 'StartServerBaselineRunRequest' });
export type StartServerBaselineRunRequest = z.infer<typeof StartServerBaselineRunRequestSchema>;

export const MAX_FLEET_RUN_SERVERS = 200;

export const StartBaselineRunsRequestSchema = z
  .object({
    serverIds: z.array(z.uuid()).min(1).max(MAX_FLEET_RUN_SERVERS).optional(),
    all: z.literal(true).optional().describe('Every server that has a baseline assigned.'),
    baselineId: z
      .uuid()
      .optional()
      .describe('Check against this baseline instead of the assigned ones.'),
  })
  .refine((body) => (body.serverIds === undefined) !== (body.all === undefined), {
    message: 'Give either serverIds or all.',
  })
  .meta({ id: 'StartBaselineRunsRequest' });
export type StartBaselineRunsRequest = z.infer<typeof StartBaselineRunsRequestSchema>;

export const SKIP_REASONS = ['already_running', 'no_baseline'] as const;
export const StartBaselineRunsResultSchema = z
  .object({
    runs: z.array(CheckRunSummarySchema),
    skipped: z.array(
      z.object({ serverId: z.uuid(), serverName: z.string(), reason: z.enum(SKIP_REASONS) }),
    ),
  })
  .meta({
    id: 'StartBaselineRunsResult',
    description:
      'The runs that were queued, and the servers that were left out with the reason (a server that has no baseline, or that already has a run going). The runs are worked on in the background, at most `SW_CHECKS_PARALLELISM` at a time.',
  });
export type StartBaselineRunsResult = z.infer<typeof StartBaselineRunsResultSchema>;

export const FLEET_TRENDS = ['better', 'worse', 'same'] as const;
export const BaselineFleetItemSchema = z
  .object({
    server: z.object({
      id: z.uuid(),
      name: z.string(),
      state: z.string(),
      country: z.string().nullable(),
      tags: z.array(z.string()),
    }),
    baseline: z
      .object({ id: z.uuid(), name: z.string(), version: z.number().int().positive() })
      .nullable(),
    assignedBy: z.enum(['server', 'tag', 'none']),
    lastRun: CheckRunSummarySchema.nullable().describe(
      'The newest run that finished, completed or not.',
    ),
    trend: z
      .enum(FLEET_TRENDS)
      .nullable()
      .describe(
        'Better or worse than the completed run before it; null with fewer than two completed runs.',
      ),
    running: z.boolean().describe('A run of this server is queued or going on now.'),
  })
  .meta({ id: 'BaselineFleetItem' });
export type BaselineFleetItem = z.infer<typeof BaselineFleetItemSchema>;

export const BaselineFleetSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    totals: z.object({
      servers: z.number().int().nonnegative(),
      assigned: z.number().int().nonnegative(),
      checked: z.number().int().nonnegative().describe('Servers with a completed run.'),
      failing: z
        .number()
        .int()
        .nonnegative()
        .describe('Servers whose last completed run has a `fail`.'),
      warning: z.number().int().nonnegative().describe('Servers with a `warn` and no `fail`.'),
      unreachable: z
        .number()
        .int()
        .nonnegative()
        .describe('Servers whose last run could not observe them.'),
      lastRunAt: z.iso.datetime().nullable(),
      failingChecks: z.number().int().nonnegative(),
      warningChecks: z.number().int().nonnegative(),
    }),
    items: z.array(BaselineFleetItemSchema),
  })
  .meta({ id: 'BaselineFleet' });
export type BaselineFleet = z.infer<typeof BaselineFleetSchema>;
