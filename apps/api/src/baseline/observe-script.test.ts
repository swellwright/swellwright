import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { OBSERVATION_KINDS } from '@swellwright/contracts';

import { findShell } from '../servers/ssh-test-support.js';
import { evaluateCheck } from './evaluate.js';
import { parseObservations } from './parse.js';
import type { PlannedObservation } from './plan.js';
import { loadObserveScript } from './script.js';

const script = loadObserveScript();

/** The text of the script without its comments: what can run. */
const code = script.text
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

/** A command in command position (see the test of the built-in scripts of the library). */
const at = (words: string, rest = ''): RegExp =>
  // A pipe counts only when a space follows it: `(halt|sync)` inside an awk pattern is not a command.
  new RegExp(String.raw`(?:^|[;&(]|\|\s|\$\(|\b(?:then|do|else)\s)\s*(?:${words})\b${rest}`, 'mu');

const FORBIDDEN: readonly [RegExp, string][] = [
  [
    at(
      'rm|mv|cp|mkdir|rmdir|touch|chmod|chown|chgrp|ln|tee|dd|truncate|mkfifo|mknod|shred|install',
    ),
    'a command that writes',
  ],
  [/\b(sed|perl)\s+(-[a-z]*i|--in-place)/u, 'an in-place edit'],
  [
    at('wget|nc|ncat|socat|telnet|scp|sftp|ftp|rsync|ping|dig|nslookup|traceroute|mtr'),
    'a network tool',
  ],
  [/(?:^|[;&|(]|\$\()\s*ssh\s/mu, 'ssh'],
  [at('apt-get', String.raw`\s+(?!-s\b)`), 'apt-get other than the simulation'],
  [
    at(
      'apt|aptitude|dpkg|yum|dnf|zypper|apk|pip|pip3|npm|snap',
      String.raw`\s+(install|remove|purge|upgrade|update|autoremove|dist-upgrade|-i\b|-r\b)`,
    ),
    'a package change',
  ],
  [
    /\bsystemctl\s+(start|stop|restart|reload|try-restart|enable|disable|mask|unmask|kill|reset-failed|daemon-reload|edit|set-|isolate|reboot|poweroff|halt)/u,
    'a service change',
  ],
  [
    at('kill|pkill|killall|reboot|shutdown|poweroff|halt|init|telinit'),
    'a process or power command',
  ],
  [
    /\bdocker\s+(run|exec|rm|stop|start|restart|kill|pull|push|build|create|prune|rmi|network|volume|cp|commit|tag|login|logout|update|pause|unpause)\b/u,
    'a docker change',
  ],
  [
    /\bufw\s+(enable|disable|allow|deny|reject|limit|delete|reset|reload|insert|route|default|logging)\b/u,
    'a firewall change',
  ],
  [/\b(iptables|ip6tables)\b.*\s-[AIDFXPNRZ]\b/u, 'an iptables change'],
  [
    /\bfail2ban-client\s+(set|start|stop|reload|unban|ban|add|restart|flushlogs)\b/u,
    'a fail2ban change',
  ],
  [
    /\b(timedatectl\s+set-|date\s+(-s|--set)|hostnamectl\s+set-|sysctl\s+-w|localectl\s+set-)/u,
    'a system setting',
  ],
  [
    at('mount|umount|swapon|swapoff|modprobe|insmod|rmmod|losetup|fdisk|parted|mkfs|fsck'),
    'a device command',
  ],
  [/(?:^|[;&(])\s*(?:source|\.)\s+[/~$.]/mu, 'sourcing a file'],
  [/\b(sh|bash|dash|zsh)\s+-c\b/u, 'a nested shell'],
  [at('sudo'), 'sudo inside the script (the runner decides who runs it)'],
  [
    at('crontab|at|batch|useradd|userdel|usermod|groupadd|passwd|chpasswd|visudo'),
    'an account or schedule change',
  ],
  [
    /\bcurl\b[^\n]*\s(-o|--output|-O|-T|--upload-file|-d|--data|-X|--request|-F)\s(?!\/dev\/null)/u,
    'curl that saves or sends',
  ],
];

const functionBody = (name: string): string => {
  const start = script.text.indexOf(`\n${name}() {`);
  assert.ok(start >= 0, `${name} exists`);
  const end = script.text.indexOf('\n}\n', start);
  return script.text.slice(start, end + 3);
};

describe('the observation script, read as text', () => {
  it('is POSIX sh with LF line endings and a header that promises what a read-only script promises', () => {
    assert.ok(script.text.startsWith('#!/bin/sh\n# swellwright-baseline: schema 1\n'));
    assert.ok(!script.text.includes('\r'));
    const header = script.text
      .split('\n')
      .filter((line) => line.startsWith('#'))
      .join('\n');
    for (const promise of [
      'read-only',
      'never prints a',
      'bounded',
      'POSIX sh',
      'no network access',
    ]) {
      assert.ok(header.includes(promise), `promises "${promise}"`);
    }
    assert.match(script.sha256, /^[0-9a-f]{64}$/u);
  });

  it('parses with sh and dash', () => {
    const shell = findShell();
    if (shell === undefined) {
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'sw-observe-syntax-'));
    try {
      writeFileSync(join(dir, 'observe.sh'), script.text);
      const result = spawnSync(shell.shell, ['-n', join(dir, 'observe.sh')], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('contains nothing that writes, changes, installs or reaches beyond the machine', () => {
    for (const [pattern, why] of FORBIDDEN) {
      assert.ok(!pattern.test(code), `the script must not contain ${why}: ${String(pattern)}`);
    }
    // The only redirections are to /dev/null and between the descriptors of the driver, and from files that are read.
    const rest = code
      .replaceAll('>/dev/null', '')
      .replaceAll('2>&1', '')
      .replaceAll('>&3', '')
      .replaceAll('>&4', '')
      .replaceAll('3>&1', '')
      .replaceAll('4>&1', '')
      .replaceAll(/^exec 3>&1$/gmu, '');
    // A `>` that is followed by a number is a comparison in awk. Any other `>` that is left writes somewhere.
    const redirects = rest
      .split('\n')
      .filter((line) => /(?<![-=<>])>{1,2}\s*(?!\d|&|=|\/dev\/null)\S/u.test(line));
    assert.deepEqual(redirects, [], 'every output redirection is to /dev/null or a descriptor');
  });

  it('uses eval once, for the one assignment of a parameter, and never runs what a value holds', () => {
    const evals = code.match(/\beval\b[^\n]*/gu) ?? [];
    assert.deepEqual(evals, ['eval "P_$_n=\\$_v"']);
    assert.ok(code.includes("case $_n in '' | *[!a-z]*) continue ;; esac"));
    assert.ok(code.includes('\nset -f\n'));
  });

  it('has a function for every kind of the catalogue and no function the catalogue lacks', () => {
    const functions = [...script.text.matchAll(/^obs_([a-z0-9_]+)\(\) \{/gmu)].map(
      (match) => match[1],
    );
    const kinds = OBSERVATION_KINDS.map((def) => def.kind.replaceAll('.', '_'));
    assert.deepEqual([...functions].sort(), [...kinds].sort());
  });

  it('reports every field of the catalogue, and only fields it has', () => {
    for (const def of OBSERVATION_KINDS) {
      const body = functionBody(`obs_${def.kind.replaceAll('.', '_')}`);
      for (const field of def.fields) {
        if (def.kind === 'time.sync' && field.name === 'skewSeconds') {
          // The one field that is made by the server of Swellwright, which knows its own clock.
          continue;
        }
        assert.ok(body.includes(field.name), `${def.kind} reports ${field.name}`);
      }
      for (const [, name] of body.matchAll(/\bkv ([A-Za-z]+)\b/gu)) {
        assert.ok(
          def.fields.some((field) => field.name === name),
          `${def.kind} prints ${String(name)}, which the catalogue lacks`,
        );
      }
    }
  });

  it('prints through kv only, and never reads an environment variable of a container by value', () => {
    // No bare printf of a value: the lines that print are kv, the driver's markers and awk programs that print fields.
    assert.ok(!/docker[^\n]*inspect[^\n]*\.Config\.Env[^\n]*>/u.test(code));
    const envUse = functionBody('obs_docker_container');
    assert.ok(envUse.includes('{{range .Config.Env}}'));
    // Every entry comes as one JSON string, so a line break inside a value cannot start a line of its own.
    assert.ok(envUse.includes('{{range .Config.Env}}{{println (json .)}}{{end}}'));
    assert.ok(!envUse.includes('{{println .}}'));
    // Of every variable only the name is kept, and only when it is a variable name; besides the four that are not secret.
    assert.ok(envUse.includes('if (name !~ /^[A-Za-z_][A-Za-z0-9_.-]*$/) next'));
    assert.ok(
      envUse.includes(
        'name == "SNI_VERIFICATION" || name == "NODE_PORT" || name == "NODE_ENV" || name == "TZ"',
      ),
    );
  });
});

// ---- running it against stand-ins ----------------------------------------------------------------------------------

const shell = findShell();
const shimPath = process.env['SW_TEST_SHELL_PATH'];

function available(): boolean {
  if (shell === undefined) {
    return false;
  }
  const result = spawnSync(
    shell.shell,
    [
      '-c',
      'command -v awk && command -v sed && command -v sort && command -v stat && command -v timeout && command -v ls',
    ],
    {
      env: { PATH: [...shell.extraPath, process.env['PATH'] ?? ''].join(delimiter) },
      encoding: 'utf8',
    },
  );
  return result.status === 0;
}

/** One stand-in command: answers by the start of its arguments, with exact text. */
type Answer = readonly [argsStart: string, stdout: string, status?: number];

function makeShim(dir: string, name: string, answers: readonly Answer[]): void {
  const cases = answers
    .map(
      ([args, out, status = 0]) =>
        `  '${args}'*) cat <<'SWEOF'\n${out}SWEOF\n    exit ${String(status)} ;;`,
    )
    .join('\n');
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\ncase "$*" in\n${cases}\nesac\nexit 1\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
}

interface Machine {
  readonly root: string;
  readonly bin: string;
  readonly work: string;
  readonly secrets: readonly string[];
}

/** A small file tree and a set of commands that stand for an Ubuntu node. */
function buildMachine(options: { root: boolean }): Machine {
  const base = mkdtempSync(join(tmpdir(), 'sw-observe-'));
  const root = join(base, 'root');
  const bin = join(base, 'bin');
  const work = join(base, 'work');
  for (const dir of [
    'etc',
    'etc/nginx/sites-enabled',
    'etc/haproxy',
    'etc/sudoers.d',
    'proc/sys/net/ipv4',
    'boot',
    'var/log',
    'var/run',
    'home/deploy/.ssh',
    'srv',
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  mkdirSync(bin, { recursive: true });
  mkdirSync(work, { recursive: true });
  const put = (path: string, text: string): void => {
    writeFileSync(join(root, path), text);
  };
  put(
    'etc/os-release',
    'PRETTY_NAME="Ubuntu 24.04.5 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nVERSION_CODENAME=noble\n',
  );
  put('proc/uptime', '25355.12 99999.00\n');
  put(
    'proc/meminfo',
    'MemTotal:        2015232 kB\nMemFree:          300000 kB\nMemAvailable:    1596000 kB\nSwapTotal:        524284 kB\nSwapFree:         500000 kB\n',
  );
  put('proc/sys/net/ipv4/tcp_congestion_control', 'bbr\n');
  put('boot/vmlinuz-6.8.0-36-generic', '');
  put('boot/vmlinuz-6.8.0-100-generic', '');
  put('var/run/reboot-required', '');
  put('var/run/reboot-required.pkgs', 'libc6\ndbus\n');
  put('etc/nginx/sites-enabled/default', '');
  put(
    'etc/haproxy/haproxy.cfg',
    'frontend https_in\n  bind :443\n  default_backend decoy_default\nbackend decoy_default\n  server a 127.0.0.1:8444\n',
  );
  put('etc/sudoers', 'Defaults env_reset\nroot ALL=(ALL:ALL) ALL\n');
  put('etc/sudoers.d/90-ops', 'deploy ALL=(ALL) NOPASSWD:ALL\n');
  const secretKey =
    'AAAAC3NzaC1lZDI1NTE5AAAAIPrivateLookingKeyBodyThatMustNeverBePrinted0123456789';
  const shadowHash = '$6$rounds=5000$saltsalt$hashhashhashhashhashhashhashhashhashhashhashhash';
  put('home/deploy/.ssh/authorized_keys', `ssh-ed25519 ${secretKey} deploy@laptop\n`);
  put(
    'etc/shadow',
    `root:${shadowHash}:19000:0:99999:7:::\ndeploy:${shadowHash}:19000:0:99999:7:::\nghost::19000:0:99999:7:::\n`,
  );
  put(
    'var/log/swellwright-node-installer.log',
    [
      '2026-11-20 10:00:00 === swellwright-node-installer 1.0.2, action: verify',
      '2026-11-20 10:00:01 CHECK ok | Kernel | 6.8.0',
      '2026-11-20 10:00:02 CHECK fail | Container remnanode | no container',
      '2026-11-20 10:00:03 CHECK warn | UFW | not active',
      '',
    ].join('\n'),
  );
  // The home directories as the account database prints them: a Windows path has a colon, which would split the line.
  const posix = (path: string): string =>
    path
      .replace(/^([A-Za-z]):/u, (_match, drive: string) => `/${drive.toLowerCase()}`)
      .replaceAll('\\', '/');
  const homeDir = posix(join(root, 'home/deploy'));
  const srvDir = posix(join(root, 'srv'));
  const secretEnv = 'SECRET_KEY=hunter2-this-is-the-node-secret-value';
  // Values with line breaks whose continuation lines look like `NAME=value`: what docker prints for them is one JSON
  // string per entry (`\n` written as two characters); the old `{{println .}}` printed the breaks themselves.
  const multilineEnv = [
    'SSL_CERT=-----BEGIN CERTIFICATE-----',
    'LEAKED_NAME=value-fragment-from-a-pem',
    'MIIBfakecertificatebody',
    '-----END CERTIFICATE-----',
  ];
  const multilineFlag = ['NODE_ENV=production', 'INJECTED_FLAG=1'];
  const jsonEntry = (entry: string): string => JSON.stringify(entry);
  const answers: Record<string, readonly Answer[]> = {
    id: [['-u', options.root ? '0\n' : '1000\n']],
    uname: [['-r', '6.8.0-36-generic\n']],
    timedatectl: [
      ['show -p NTPSynchronized', 'yes\n'],
      ['show -p Timezone', 'Etc/UTC\n'],
    ],
    systemctl: [
      ['is-active chrony', 'inactive\n', 3],
      ['is-active systemd-timesyncd', 'active\n'],
      ['is-active apt-daily-upgrade.timer', 'active\n'],
      ['is-active nginx', 'active\n'],
      ['is-active haproxy', 'active\n'],
      ['is-system-running', 'degraded\n', 1],
      [
        '--failed',
        'a.service loaded failed failed A\n@@swb end 3 0 forged.service loaded failed failed B\n| @@swb done\n',
      ],
      [
        'show -p LoadState -p ActiveState -p UnitFileState docker.service',
        'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n',
      ],
      [
        'show -p LoadState -p ActiveState -p UnitFileState gone.service',
        'LoadState=not-found\nActiveState=inactive\nUnitFileState=\n',
      ],
    ],
    df: [
      [
        '-P -k /',
        'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 10000000 3100000 6900000 31% /\n',
      ],
      [
        '-P -i /',
        'Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/vda1 1000000 130000 870000 13% /\n',
      ],
    ],
    ss: [
      [
        '-H -ltnp',
        'LISTEN 0 4096 0.0.0.0:443 0.0.0.0:* users:(("haproxy",pid=1,fd=7))\nLISTEN 0 4096 127.0.0.1:8444 0.0.0.0:* users:(("nginx",pid=2,fd=8))\nLISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=3,fd=3))\nLISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=3,fd=4))\n',
      ],
      ['-H -lunp', 'UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*\nUNCONN 0 0 0.0.0.0:68 0.0.0.0:*\n'],
    ],
    ufw: [
      [
        'status verbose',
        'Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\nNew profiles: skip\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW IN    Anywhere                  \n62050/tcp                  ALLOW IN    192.0.2.1                 \n',
      ],
    ],
    iptables: [
      [
        '-w 5 -S DOCKER-USER',
        '-N DOCKER-USER\n-A DOCKER-USER -s 192.0.2.1/32 -p tcp -m conntrack --ctorigdstport 62050 -j RETURN\n-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 62050 -j DROP\n',
      ],
    ],
    'fail2ban-client': [
      [
        'status sshd',
        'Status for the jail: sshd\n`- Actions\n   |- Currently banned:\t2\n   `- Banned IP list:\t192.0.2.5\n',
      ],
      ['status', 'Status\n|- Number of jail:\t1\n`- Jail list:\tsshd\n'],
    ],
    sshd: [
      [
        '-T',
        'port 22\npermitrootlogin yes\npasswordauthentication no\nmaxauthtries 6\nallowusers deploy ops\n',
      ],
    ],
    getent: [
      ['passwd certsync', `certsync:x:999:999::${srvDir}:/bin/bash\n`],
      [
        'passwd',
        `root:x:0:0:root:${srvDir}:/bin/bash\ndeploy:x:1000:1000::${homeDir}:/bin/bash\nwww:x:33:33::/var/www:/usr/sbin/nologin\n`,
      ],
      ['ahostsv4 node1.example.com', '192.0.2.10 STREAM node1.example.com\n192.0.2.10 DGRAM\n'],
    ],
    'ssh-keygen': [
      [
        '-l -f - -E sha256',
        '256 SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdE deploy@laptop (ED25519)\n',
      ],
    ],
    docker: [
      [
        'container inspect --format {{range .Config.Env}}{{println .}}',
        `PATH=/usr/bin\n${secretEnv}\n${multilineEnv.join('\n')}\n${multilineFlag.join('\n')}\nSNI_VERIFICATION=true\nTZ=UTC\nNODE_PORT=62050\n`,
      ],
      [
        'container inspect --format {{range .Config.Env}}{{println (json .)}}',
        [
          'PATH=/usr/bin',
          secretEnv,
          multilineEnv.join('\n'),
          multilineFlag.join('\n'),
          'SNI_VERIFICATION=true',
          'TZ=UTC',
          'NODE_PORT=62050',
        ]
          .map(jsonEntry)
          .join('\n')
          .concat('\n'),
      ],
      [
        'container inspect --format {{.State.Status}}',
        'running|remnawave/node:3.4.6|sha256:abcdef0123456789|always|none|2026-11-20T10:00:00.123456789Z\n',
      ],
      ['version --format', '29.1.0\n'],
      ['compose version --short', '5.0.0\n'],
      ['ps -aq', 'a1\nb2\n'],
      ['ps -q', 'a1\n'],
    ],
    nginx: [
      ['-v', 'nginx version: nginx/1.30.7\n'],
      ['-t', '', 0],
    ],
    haproxy: [
      ['-v', 'HAProxy version 3.2.27-1ppa1~noble 2026/10/01 - https://haproxy.org/\n'],
      ['-c -f', '', 0],
    ],
    openssl: [['x509 -in', 'subject=CN = node1.example.com\n']],
    curl: [['-s -k -o /dev/null', '404\n']],
    hostname: [
      ['-f', 'node1.example.com\n'],
      ['-I', '192.0.2.10\n'],
    ],
    ip: [
      ['-4 route get', '1.1.1.1 via 192.0.2.1 dev eth0 src 192.0.2.10 uid 0\n'],
      ['-4 -o addr show', '2: eth0    inet 192.0.2.10/24 brd 192.0.2.255 scope global eth0\n'],
    ],
    'apt-get': [
      [
        '-s',
        'Inst libc6 [2.39] (2.39-1 Ubuntu:24.04/noble-security [amd64])\nInst vim [1] (2 Ubuntu:24.04/noble-updates [amd64])\n',
      ],
    ],
    dpkg: [
      ['-s unattended-upgrades', 'Package: unattended-upgrades\nStatus: install ok installed\n'],
    ],
    'apt-config': [['dump', 'APT::Periodic::Unattended-Upgrade "1";\n']],
    chronyc: [['tracking', 'System time     : 0.000123456 seconds fast of NTP time\n']],
  };
  for (const [name, list] of Object.entries(answers)) {
    makeShim(bin, name, list);
  }
  return {
    root,
    bin,
    work,
    secrets: [
      secretKey,
      shadowHash,
      'hunter2-this-is-the-node-secret-value',
      'LEAKED_NAME',
      'value-fragment-from-a-pem',
      'MIIBfakecertificatebody',
      'BEGIN CERTIFICATE',
      'INJECTED_FLAG',
      'production',
    ],
  };
}

function runScript(machine: Machine, plan: string): { stdout: string; status: number | null } {
  if (shell === undefined) {
    throw new Error('no shell');
  }
  // As the step layer runs it: `sh script.sh`, the plan on the standard input.
  const file = join(machine.work, '..', 'observe.sh');
  writeFileSync(file, script.text);
  const result = spawnSync(shell.shell, [file], {
    input: plan,
    encoding: 'utf8',
    cwd: machine.work,
    timeout: 60_000,
    env: {
      PATH: [
        machine.bin,
        ...(shimPath === undefined ? [] : [shimPath]),
        ...shell.extraPath,
        process.env['PATH'] ?? '',
      ].join(delimiter),
      SWB_ROOT: machine.root,
      HOME: machine.work,
      LANG: 'C',
      ...(process.env['SystemRoot'] === undefined ? {} : { SystemRoot: process.env['SystemRoot'] }),
    },
  });
  return { stdout: result.stdout, status: result.status };
}

const PLAN = [
  'os.release',
  'kernel',
  'uptime',
  'time.sync',
  'disk.usage\tpath=/',
  'memory',
  'updates.pending',
  'updates.auto',
  'systemd.failed',
  'service.state\tunit=docker.service',
  'service.state\tunit=gone.service',
  'port.listener\tport=443',
  'port.listener\tport=8444',
  'port.listener\tport=9999',
  'ports.public',
  'ufw.status',
  'iptables.chain\tchain=DOCKER-USER',
  'fail2ban.status',
  'sshd.effective',
  'ssh.keys',
  'sudoers',
  'users.login',
  'sysctl.value\tkey=net.ipv4.tcp_congestion_control',
  'docker.engine',
  'docker.container\tname=remnanode',
  'nginx.config',
  'haproxy.config',
  'http.local\tport=443\tscheme=https\ttarget=self\tsni=x.invalid',
  'dns.self',
  'installer.journal',
  'certsync.account\tuser=certsync',
  'no.such.kind',
]
  .map((line, index) => `${String(index + 1)}\t${line}`)
  .join('\n')
  .concat('\n');

const planned = (): PlannedObservation[] =>
  PLAN.split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [index = '', kind = '', ...pairs] = line.split('\t');
      return {
        index: Number(index),
        kind,
        params: Object.fromEntries(pairs.map((pair) => pair.split('=') as [string, string])),
      };
    });

describe('the observation script against stand-in tools', { skip: !available() }, () => {
  const machines: Machine[] = [];
  let asRoot: Machine;
  let asUser: Machine;
  before(() => {
    asRoot = buildMachine({ root: true });
    asUser = buildMachine({ root: false });
    machines.push(asRoot, asUser);
  });
  after(() => {
    for (const machine of machines) {
      rmSync(join(machine.root, '..'), { recursive: true, force: true });
    }
  });

  it('reads a node as root, field by field', () => {
    const { stdout, status } = runScript(asRoot, PLAN);
    assert.equal(status, 0);
    const parsed = parseObservations(Buffer.from(stdout), planned());
    assert.equal(parsed.recognised, true);
    assert.equal(parsed.complete, true);
    assert.equal(parsed.uid, 0);
    assert.deepEqual(parsed.warnings, []);
    const fields = (index: number) => parsed.observations.get(index)?.fields;
    assert.equal(fields(1)?.['codename'], 'noble');
    assert.deepEqual(fields(2), {
      running: '6.8.0-36-generic',
      // Two images are in /boot: the newer one is not the running one.
      latestInstalled: '6.8.0-100-generic',
      behind: true,
      rebootRequired: true,
      rebootPackages: ['dbus', 'libc6'],
    });
    assert.equal(fields(3)?.['seconds'], 25_355);
    assert.equal(fields(4)?.['synchronized'], true);
    assert.equal(fields(4)?.['service'], 'systemd-timesyncd');
    assert.equal(fields(4)?.['offsetSeconds'], 0.000123456);
    assert.deepEqual(fields(5), {
      mountpoint: '/',
      usedPercent: 31,
      availableMiB: 6738,
      inodeUsedPercent: 13,
    });
    assert.deepEqual(fields(6), {
      totalMiB: 1968,
      availableMiB: 1558,
      availablePercent: 79,
      swapTotalMiB: 511,
      swapUsedPercent: 4,
    });
    assert.deepEqual(fields(7), {
      manager: 'apt',
      upgradable: 2,
      security: 1,
      listAgeSeconds: null,
    });
    assert.deepEqual(fields(8), { installed: true, enabled: true, timerActive: true });
    assert.deepEqual(fields(10), { exists: true, active: 'active', enabled: 'enabled' });
    assert.equal(fields(11)?.['exists'], false);
    assert.deepEqual(fields(12), {
      listening: true,
      publicly: true,
      addresses: ['0.0.0.0'],
      processes: ['haproxy'],
    });
    assert.deepEqual(fields(13), {
      listening: true,
      publicly: false,
      addresses: ['127.0.0.1'],
      processes: ['nginx'],
    });
    assert.deepEqual(fields(14), {
      listening: false,
      publicly: false,
      addresses: [],
      processes: [],
    });
    assert.deepEqual(fields(15)?.['ports'], ['tcp/22', 'tcp/443', 'udp/68']);
    assert.deepEqual(fields(16), {
      installed: true,
      active: true,
      defaultIncoming: 'deny',
      rules: ['22/tcp ALLOW IN Anywhere', '62050/tcp ALLOW IN 192.0.2.1'],
      ruleCount: 2,
    });
    assert.equal(fields(17)?.['ruleCount'], 2);
    assert.match(String(fields(17)?.['text']), /ctorigdstport 62050 -j DROP/u);
    assert.deepEqual(fields(18), {
      installed: true,
      active: true,
      jails: ['sshd'],
      bannedCount: 2,
    });
    assert.equal(fields(19)?.['permitrootlogin'], 'yes');
    assert.equal(fields(19)?.['allowusers'], 'deploy ops');
    assert.deepEqual(fields(20), {
      keys: ['deploy SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdE ED25519'],
      total: 1,
      accounts: ['deploy'],
      invalid: 0,
    });
    assert.deepEqual(fields(21), { present: true, dropIns: ['90-ops'], nopasswd: ['deploy'] });
    assert.deepEqual(fields(22)?.['uidZero'], ['root']);
    assert.deepEqual(fields(22)?.['accounts'], ['root:0', 'deploy:1000']);
    assert.deepEqual(fields(22)?.['emptyPassword'], ['ghost']);
    assert.deepEqual(fields(23), { exists: true, value: 'bbr' });
    assert.deepEqual(fields(24), {
      installed: true,
      running: true,
      version: '29.1.0',
      composeVersion: '5.0.0',
      containers: 2,
      runningContainers: 1,
    });
    assert.equal(fields(25)?.['tag'], '3.4.6');
    assert.equal(fields(25)?.['restartPolicy'], 'always');
    // Names only: no line of a value, even one that looks like `NAME=value`; a multi-line flag gives its name and no value.
    assert.deepEqual(fields(25)?.['envNames'], [
      'PATH',
      'SECRET_KEY',
      'SSL_CERT',
      'NODE_ENV',
      'SNI_VERIFICATION',
      'TZ',
      'NODE_PORT',
    ]);
    assert.deepEqual(fields(25)?.['envFlags'], [
      'SNI_VERIFICATION=true',
      'TZ=UTC',
      'NODE_PORT=62050',
    ]);
    assert.deepEqual(fields(26), {
      installed: true,
      active: true,
      valid: true,
      version: '1.30.7',
      enabledSites: ['default'],
    });
    assert.deepEqual(fields(27), {
      installed: true,
      active: true,
      valid: true,
      version: '3.2.27-1ppa1~noble',
      frontends: ['https_in'],
      defaultBackends: ['decoy_default'],
    });
    assert.deepEqual(fields(28), { status: 404 });
    assert.deepEqual(fields(29), {
      name: 'node1.example.com',
      resolves: true,
      addresses: ['192.0.2.10'],
      local: true,
    });
    assert.equal(fields(30)?.['version'], '1.0.2');
    assert.equal(fields(30)?.['verifyFail'], 1);
    assert.equal(fields(30)?.['verifyWarn'], 1);
    assert.deepEqual(fields(30)?.['failedChecks'], ['Container remnanode']);
    assert.equal(fields(31)?.['exists'], true);
    assert.equal(parsed.observations.get(32)?.status, 'unsupported');
  });

  it('never prints a secret: not a key body, not a password hash, not the value of an environment variable', () => {
    const { stdout } = runScript(asRoot, PLAN);
    for (const secret of asRoot.secrets) {
      assert.ok(!stdout.includes(secret), `the output holds ${secret.slice(0, 12)}...`);
    }
    assert.ok(!stdout.includes('rounds=5000'));
    assert.ok(!stdout.includes('3.4.6') || stdout.includes('tag=3.4.6'));
  });

  it('without root says so for what needs it, and still reads the rest', () => {
    const { stdout } = runScript(asUser, PLAN);
    const parsed = parseObservations(Buffer.from(stdout), planned());
    assert.equal(parsed.uid, 1000);
    for (const index of [12, 13, 14, 16, 17, 18, 19, 20, 21, 24, 25, 26, 27, 30, 31]) {
      assert.equal(
        parsed.observations.get(index)?.status,
        'denied',
        `observation ${String(index)}`,
      );
    }
    assert.equal(parsed.observations.get(1)?.status, 'ok');
    assert.equal(parsed.observations.get(4)?.status, 'ok');
    // The accounts are listed, the names of the empty passwords cannot be.
    assert.equal(parsed.observations.get(22)?.fields?.['emptyPassword'], null);
    assert.deepEqual(parsed.observations.get(22)?.fields?.['uidZero'], ['root']);
  });

  it('treats a parameter that is hostile as data: nothing is run, nothing is written', () => {
    const machine = buildMachine({ root: true });
    machines.push(machine);
    const hostile = [
      `1\tfile.stat\tpath=/tmp/x'; touch ${join(machine.work, 'PWNED1')} #`,
      `2\tfile.stat\tpath=$(touch ${join(machine.work, 'PWNED2')})`,
      `3\tfile.stat\tpath=\`touch ${join(machine.work, 'PWNED3')}\``,
      `4\tfile.hash\tpath=/etc/x"; touch ${join(machine.work, 'PWNED4')}; "`,
      `5\tsysctl.value\tkey=net.ipv4.x;touch ${join(machine.work, 'PWNED5')}`,
      `6\tservice.state\tunit=a.service;touch ${join(machine.work, 'PWNED6')}`,
      `7\tos.release\tpath=*`,
      `8\tfile.stat\tpath=*`,
      '9\tdisk.usage\tpath=-h',
      '',
    ].join('\n');
    const { stdout, status } = runScript(machine, hostile);
    assert.equal(status, 0);
    for (let index = 1; index <= 6; index += 1) {
      assert.ok(
        !existsSync(join(machine.work, `PWNED${String(index)}`)),
        `PWNED${String(index)} exists`,
      );
    }
    const parsed = parseObservations(
      Buffer.from(stdout),
      Array.from({ length: 9 }, (_, index) => ({
        index: index + 1,
        kind: 'file.stat',
        params: {},
      })),
    );
    assert.equal(parsed.complete, true);
    // A star is not a pattern for the shell: it names a path that does not exist.
    assert.equal(parsed.observations.get(8)?.fields?.['exists'], false);
  });

  it('keeps a value that looks like a marker a value', () => {
    const { stdout } = runScript(asRoot, '1\tsystemd.failed\n2\tuptime\n');
    const parsed = parseObservations(Buffer.from(stdout), [
      { index: 1, kind: 'systemd.failed', params: {} },
      { index: 2, kind: 'uptime', params: {} },
    ]);
    assert.deepEqual(parsed.warnings, []);
    assert.equal(parsed.complete, true);
    assert.equal(parsed.observations.get(1)?.status, 'ok');
    assert.equal(parsed.observations.get(2)?.fields?.['seconds'], 25_355);
    // The forged marker is in the output only behind "| ".
    assert.ok(!stdout.split('\n').some((line) => line.startsWith('@@swb end 3')));
  });

  it('reports a failed systemctl or ss as a failed observation, never as "nothing failed" or "nothing listens"', () => {
    const machine = buildMachine({ root: true });
    machines.push(machine);
    // systemctl answers the state and then times out listing the failed units; ss fails with and without -H.
    makeShim(machine.bin, 'systemctl', [
      ['is-system-running', 'running\n'],
      ['--failed', '', 124],
    ]);
    makeShim(machine.bin, 'ss', []);
    const plan = '1\tsystemd.failed\n2\tports.public\n3\tport.listener\tport=22\n';
    const { stdout } = runScript(machine, plan);
    const parsed = parseObservations(Buffer.from(stdout), [
      { index: 1, kind: 'systemd.failed', params: {} },
      { index: 2, kind: 'ports.public', params: {} },
      { index: 3, kind: 'port.listener', params: { port: '22' } },
    ]);
    for (const index of [1, 2, 3]) {
      assert.equal(parsed.observations.get(index)?.status, 'error', `observation ${String(index)}`);
    }
    const check = (kind: string, field: string, expect: Record<string, unknown>) =>
      evaluateCheck(
        {
          id: 'a.b',
          title: 'A check',
          category: 'system',
          severity: 'high',
          observe: { kind, field },
          expect,
        },
        parsed.observations.get(kind === 'systemd.failed' ? 1 : kind === 'ports.public' ? 2 : 3),
      ).status;
    assert.equal(check('systemd.failed', 'failedCount', { atMost: 0 }), 'error');
    assert.equal(check('ports.public', 'ports', { in: ['tcp/22'] }), 'error');
    assert.equal(check('port.listener', 'publicly', { equals: false }), 'error');
  });

  it('does not present missing process names as an empty list without root', () => {
    const machine = buildMachine({ root: false });
    machines.push(machine);
    makeShim(machine.bin, 'ss', [['-H -ltnp', 'LISTEN 0 128 0.0.0.0:443 0.0.0.0:*\n']]);
    const parsed = parseObservations(
      Buffer.from(runScript(machine, '1\tport.listener\tport=443\n').stdout),
      [{ index: 1, kind: 'port.listener', params: { port: '443' } }],
    );
    const observation = parsed.observations.get(1);
    assert.equal(observation?.status, 'denied');
    for (const expect of [{ absent: true }, { notContains: 'haproxy' }] as const) {
      assert.equal(
        evaluateCheck(
          {
            id: 'port.owner',
            title: 'Port owner',
            category: 'network',
            severity: 'high',
            observe: { kind: 'port.listener', field: 'processes', params: { port: '443' } },
            expect,
          },
          observation,
        ).status,
        'error',
      );
    }
  });

  it('distinguishes missing units and chains from tool failures and deadlines', () => {
    const machine = buildMachine({ root: true });
    machines.push(machine);
    const show = '-p LoadState -p ActiveState -p UnitFileState';
    makeShim(machine.bin, 'systemctl', [
      [`show ${show} timeout.service`, '', 124],
      [`show ${show} bus.service`, '', 1],
      [`show ${show} missing.service`, 'LoadState=not-found\nActiveState=inactive\n', 1],
    ]);
    makeShim(machine.bin, 'iptables', [
      ['-w 5 -S TIMED', '', 124],
      ['-w 5 -S FAILED', '', 4],
      ['-w 5 -S MISSING', '', 1],
      ['-w 5 -S PRESENT', '', 1],
      ['-w 5 -S', '-P INPUT ACCEPT\n-N PRESENT\n'],
    ]);
    const planned = [
      ...['timeout.service', 'bus.service', 'missing.service'].map((unit, i) => ({
        index: i + 1,
        kind: 'service.state',
        params: { unit },
      })),
      ...['TIMED', 'FAILED', 'MISSING', 'PRESENT'].map((chain, i) => ({
        index: i + 4,
        kind: 'iptables.chain',
        params: { chain },
      })),
    ];
    const plan = planned
      .map(
        ({ index, kind, params }) =>
          `${String(index)}\t${kind}\t${Object.entries(params)
            .map(([key, value]) => `${key}=${value}`)
            .join('\t')}`,
      )
      .join('\n');
    const { observations } = parseObservations(
      Buffer.from(runScript(machine, plan).stdout),
      planned,
    );
    for (const index of [1, 4]) assert.equal(observations.get(index)?.status, 'timeout');
    for (const index of [2, 5, 7]) assert.equal(observations.get(index)?.status, 'error');
    for (const index of [3, 6]) {
      assert.equal(observations.get(index)?.status, 'ok');
      assert.equal(observations.get(index)?.fields?.['exists'], false);
    }
  });

  it('does not report zero after an inode, container-list or jail command fails', () => {
    const machine = buildMachine({ root: true });
    machines.push(machine);
    makeShim(machine.bin, 'df', [
      [
        '-P -k /',
        'Filesystem 1024-blocks Used Available Capacity Mounted on\nfs 100 10 90 10% /\n',
      ],
      ['-P -i /', '', 1],
    ]);
    makeShim(machine.bin, 'docker', [
      ['version --format {{.Server.Version}}', '26.0\n'],
      ['compose version --short', '2.0\n'],
      ['ps -aq', '', 1],
    ]);
    makeShim(machine.bin, 'fail2ban-client', [
      ['status sshd', '', 1],
      ['status', 'Jail list: sshd\n'],
    ]);
    const { stdout } = runScript(
      machine,
      '1\tdisk.usage\tpath=/\n2\tdocker.engine\n3\tfail2ban.status\n',
    );
    const parsed = parseObservations(Buffer.from(stdout), [
      { index: 1, kind: 'disk.usage', params: { path: '/' } },
      { index: 2, kind: 'docker.engine', params: {} },
      { index: 3, kind: 'fail2ban.status', params: {} },
    ]);
    assert.deepEqual(
      [...parsed.observations.values()].map((row) => row.status),
      ['error', 'error', 'error'],
    );
  });

  it('marks clipped public ports and firewall text incomplete', () => {
    const machine = buildMachine({ root: true });
    machines.push(machine);
    makeShim(machine.bin, 'ss', [
      [
        '-H -ltnp',
        Array.from(
          { length: 200 },
          (_unused, i) => `LISTEN 0 128 0.0.0.0:${String(10000 + i)} 0.0.0.0:*\n`,
        ).join('') + 'LISTEN 0 128 0.0.0.0:3306 0.0.0.0:*\n',
      ],
      ['-H -lunp', ''],
    ]);
    makeShim(machine.bin, 'iptables', [
      ['-w 5 -S DOCKER-USER', `-N DOCKER-USER\n${'-A DOCKER-USER -j RETURN\n'.repeat(18)}`],
    ]);
    const { stdout } = runScript(
      machine,
      '1\tports.public\n2\tiptables.chain\tchain=DOCKER-USER\n',
    );
    assert.match(stdout, /^\| count=201$/mu);
    const parsed = parseObservations(Buffer.from(stdout), [
      { index: 1, kind: 'ports.public', params: {} },
      { index: 2, kind: 'iptables.chain', params: { chain: 'DOCKER-USER' } },
    ]);
    assert.deepEqual(
      [...parsed.observations.values()].map((row) => row.status),
      ['error', 'error'],
    );
  });

  it('rejects clipped sudoers and login account lists instead of evaluating a prefix', () => {
    const machine = buildMachine({ root: true });
    machines.push(machine);
    for (let index = 0; index < 51; index += 1) {
      writeFileSync(join(machine.root, 'etc/sudoers.d', `test-${String(index)}`), '');
    }
    const accounts = Array.from(
      { length: 101 },
      (_unused, index) => `test-${String(index)}:x:1000:1000::/:/bin/sh`,
    );
    makeShim(machine.bin, 'getent', [['passwd', `${accounts.join('\n')}\n`]]);
    const { stdout } = runScript(machine, '1\tsudoers\n2\tusers.login\n');
    const parsed = parseObservations(Buffer.from(stdout), [
      { index: 1, kind: 'sudoers', params: {} },
      { index: 2, kind: 'users.login', params: {} },
    ]);
    assert.deepEqual(
      [...parsed.observations.values()].map(({ status, fields }) => ({ status, fields })),
      [
        { status: 'error', fields: null },
        { status: 'error', fields: null },
      ],
    );
    assert.match(stdout, /^\| count=101$/mu);
  });

  it('fails the container observation when its variables cannot be read, and tells an empty list from it', () => {
    const machine = buildMachine({ root: true });
    machines.push(machine);
    const row =
      'running|remnawave/node:3.4.6|sha256:abcdef0123456789|always|none|2026-11-20T10:00:00.123456789Z\n';
    const plan = '1\tdocker.container\tname=remnanode\n';
    const planned1 = [{ index: 1, kind: 'docker.container', params: { name: 'remnanode' } }];
    const verdict = (parsed: ReturnType<typeof parseObservations>) =>
      evaluateCheck(
        {
          id: 'a.b',
          title: 'A check',
          category: 'system',
          severity: 'high',
          observe: { kind: 'docker.container', field: 'envNames', params: { name: 'remnanode' } },
          expect: { notContains: 'DEBUG' },
        },
        parsed.observations.get(1),
      ).status;
    // The state is read, then the inspection of the variables fails (a timeout, the container removed meanwhile).
    makeShim(machine.bin, 'docker', [
      ['container inspect --format {{.State.Status}}', row],
      ['container inspect --format {{range .Config.Env}}', '', 1],
    ]);
    const failed = parseObservations(Buffer.from(runScript(machine, plan).stdout), planned1);
    assert.equal(failed.observations.get(1)?.status, 'error');
    assert.equal(verdict(failed), 'error');
    // A container without variables is a readable, empty list, and the check passes.
    makeShim(machine.bin, 'docker', [
      ['container inspect --format {{.State.Status}}', row],
      ['container inspect --format {{range .Config.Env}}', ''],
    ]);
    const empty = parseObservations(Buffer.from(runScript(machine, plan).stdout), planned1);
    assert.equal(empty.observations.get(1)?.status, 'ok');
    assert.deepEqual(empty.observations.get(1)?.fields?.['envNames'], []);
    assert.equal(verdict(empty), 'pass');
  });

  it('answers a plan line it cannot read by skipping it, and an unknown kind by 99', () => {
    const { stdout } = runScript(asRoot, 'x\tuptime\n\n7\tUPTIME\n8\tno.such\n9\tuptime\n');
    assert.ok(stdout.includes('@@swb end 8 99'));
    assert.ok(stdout.includes('@@swb begin 9 uptime'));
    assert.ok(!stdout.includes('begin 7'));
    assert.ok(stdout.endsWith('@@swb done\n'));
  });
});
