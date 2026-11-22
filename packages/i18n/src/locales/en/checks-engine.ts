/**
 * The texts of the rules, findings, reconciliation rows and impact reports (packages/conventions/src/messages.ts and the
 * descriptions of the rule parameters). English is the text of the `message` fields of the API as well; a test keeps this
 * file equal to the package. The console shows these keys in the language of the user (namespace `checks`).
 */
export const checksEngine = {
  rules: {
    host: {
      'address-policy': {
        title: 'Host address policy',
        description:
          'The address of a host is a valid IP address or host name, and is the kind the pack wants (an IP, a domain, or either).',
        params: {
          policy: 'What the address of a host must be: an IP address, a domain name, or either.',
        },
      },
      'sni-explicit': {
        title: 'Host SNI set explicitly',
        description:
          'A host sets its SNI itself, instead of leaving it to the inbound or to the address.',
      },
      'remark-unique': {
        title: 'Host remarks unique',
        description: 'Every host has a remark, and no two hosts share one.',
        params: {
          caseSensitive: 'Whether "Node" and "node" are different remarks.',
        },
      },
      'remark-pattern': {
        title: 'Host remark pattern',
        description:
          'The remark of every host matches the pattern of the pack (for example a flag, a marker and the node code).',
        params: {
          pattern:
            'The remark must match this pattern entirely. The rule does nothing until a pattern is set.',
        },
      },
      'inbound-exists': {
        title: 'Host bound to an existing inbound',
        description: 'The inbound a host points at exists, in the profile the host names.',
      },
      'serving-node': {
        title: 'Host served by a node',
        description:
          'Some node serves the inbound of every enabled host, and the nodes a host is assigned to are the ones that serve it.',
      },
      state: {
        title: 'Disabled and hidden hosts',
        description: 'Points out hosts that are disabled or hidden, so that none is forgotten.',
        params: {
          report: 'Which states to point out: `disabled`, `hidden`.',
        },
      },
      'sni-in-inbound-names': {
        title: 'Host SNI among the server names of its inbound',
        description:
          'The SNI of a host is one of the server names its REALITY inbound accepts; any other name is sent to the fallback site.',
      },
      'vless-route-id': {
        title: 'VLESS route ids',
        description:
          'A route id is within range and not in a range the pack reserves; optionally, hosts of different inbounds do not share one.',
        params: {
          reserved:
            'Route ids that must not be used. The default is the observed behaviour of Remnawave 3.4.x: 0 and 0x4000-0x4FFF.',
          max: 'The largest route id.',
          warnOnDuplicates: 'Report one route id that hosts of different inbounds share.',
        },
      },
    },
    node: {
      'has-host': {
        title: 'Node reachable by a host',
        description:
          'Some host points at every enabled node: it is assigned to it, has its address, or the node is the only one that serves the inbound of a host that names no node.',
      },
      'disabled-referenced': {
        title: 'Disabled node still referenced',
        description:
          'A disabled node is not the only server of a host and no host is still assigned to it.',
      },
      'version-skew': {
        title: 'Node and Xray versions',
        description:
          'Nodes run the same node and Xray versions as most of the fleet, on the same release line as the panel.',
        params: {
          checkNodeVersion: 'Report a node whose version differs from the one most nodes run.',
          checkXrayVersion: 'Report a node whose Xray differs from the one most nodes run.',
          sameLineAsPanel:
            "Report a node whose major.minor is not the panel's (3.4.6 and 3.4.11 are the same line).",
        },
      },
      'address-valid': {
        title: 'Node address valid',
        description: 'The address of a node is a valid IP address or host name.',
      },
      'profile-assigned': {
        title: 'Node serves a profile',
        description: 'A node has an existing config profile and at least one active inbound.',
      },
      'plugin-exists': {
        title: 'Node plugin exists',
        description: 'The node plugin a node uses exists.',
      },
      'name-pattern': {
        title: 'Node name pattern',
        description: 'The name of every node matches the pattern of the pack.',
        params: {
          pattern:
            'The name of a node must match this pattern entirely. The rule does nothing until a pattern is set.',
        },
      },
    },
    profile: {
      'inbound-tag-unique': {
        title: 'Inbound tags unique',
        description:
          'No tag is used by two inbounds of a profile or by inbounds of two profiles (the panel wants tags unique across all profiles).',
      },
      'inbound-port-clash': {
        title: 'Inbound ports do not clash',
        description:
          'No two inbounds of a profile listen on the same port of the same transport on overlapping addresses.',
      },
      'snippet-exists': {
        title: 'Snippets used by a profile exist',
        description:
          'Every snippet a configuration names, in the root list or in an outbound, a rule or a balancer, exists.',
      },
      'name-pattern': {
        title: 'Profile name pattern',
        description: 'The name of every config profile matches the pattern of the pack.',
        params: {
          pattern:
            'The name of a config profile must match this pattern entirely. The rule does nothing until a pattern is set.',
        },
      },
      unused: {
        title: 'Unused profiles',
        description: 'Points out a profile that no node uses and a profile without inbounds.',
      },
      shared: {
        title: 'Shared profiles',
        description:
          'Points out a profile that several nodes use: an edit of it restarts all of them.',
        params: {
          minNodes: 'From how many nodes on a profile counts as shared.',
        },
      },
    },
    squad: {
      'internal-empty': {
        title: 'Internal squads not empty',
        description:
          'An internal squad has inbounds (otherwise its members get no servers) and, as a hint, members.',
      },
      'inbound-exists': {
        title: 'Squad inbounds exist',
        description: 'Every inbound an internal squad lists exists in some profile.',
      },
      'name-pattern': {
        title: 'Squad name pattern',
        description: 'The name of every squad matches the pattern of the pack.',
        params: {
          pattern:
            'The name of a squad must match this pattern entirely. The rule does nothing until a pattern is set.',
          kinds: 'Which squads: `internal`, `external`.',
        },
      },
      'external-template-exists': {
        title: 'External squad templates exist',
        description:
          'The subscription templates an external squad uses exist and are of the type the squad says.',
      },
    },
    template: {
      'name-pattern': {
        title: 'Template name pattern',
        description: 'The name of every subscription template matches the pattern of the pack.',
        params: {
          pattern:
            'The name of a subscription template must match this pattern entirely. The rule does nothing until a pattern is set.',
        },
      },
      'body-present': {
        title: 'Template body readable',
        description:
          'A subscription template of a type that has a body has one that parses as JSON or YAML. A body that was not read (the panel leaves it out of its list) is never taken for a missing one.',
        params: {
          types: 'The template types that must have a body that parses (JSON or YAML).',
        },
      },
      unused: {
        title: 'Unused templates',
        description:
          'Points out a subscription template that no external squad and no host uses. The "Default" template of each type is not reported: the panel uses it on its own.',
        params: {
          ignoreNames:
            'Template names that are never reported: the panel uses its "Default" template of each type on its own, for every squad and host that names none.',
        },
      },
    },
    panel: {
      'token-expiry': {
        title: 'API token of the connection expires',
        description:
          'The API token Swellwright uses is not expired and does not expire within the warning period.',
        params: {
          warnDays: 'Warn this many days before the API token of the connection expires.',
        },
      },
    },
  },
  findings: {
    host: {
      'address-policy': {
        invalid:
          'The address "{{address}}" of the host is neither an IP address nor a valid host name.',
        not_ip: 'The address "{{address}}" is a name; the conventions want an IP address.',
        not_domain:
          'The address "{{address}}" is an IP address; the conventions want a domain name.',
      },
      'sni-explicit': {
        missing:
          'The host has no explicit SNI, so clients take it from the inbound or from the address.',
      },
      'remark-unique': {
        empty: 'The host has an empty remark.',
        duplicate: 'Hosts that have the remark "{{remark}}": {{count}}.',
      },
      'remark-pattern': {
        mismatch: 'The remark "{{remark}}" does not match the pattern {{pattern}}.',
      },
      'inbound-exists': {
        unbound: 'The host is not bound to an inbound.',
        missing_profile: 'The host is bound to a config profile that does not exist.',
        missing_inbound: 'The host is bound to an inbound that does not exist.',
        inbound_of_other_profile:
          'The inbound "{{tag}}" of the host belongs to the profile "{{profile}}", not to the profile the host names.',
      },
      'serving-node': {
        no_node:
          'No node serves the inbound "{{tag}}" of this host, so clients that pick it cannot connect.',
        node_missing: 'The host is assigned to a node that does not exist.',
        node_not_serving:
          'The host is assigned to the node "{{node}}", which does not serve its inbound "{{tag}}".',
      },
      state: {
        disabled: 'The host is disabled and is in no subscription.',
        hidden: 'The host is hidden from the subscription page.',
      },
      'sni-in-inbound-names': {
        not_listed:
          'The SNI "{{sni}}" is not one of the server names of the inbound "{{tag}}" ({{names}}); a REALITY server sends such clients to its fallback.',
      },
      'vless-route-id': {
        reserved: 'The route id {{id}} is in the reserved range {{from}}-{{to}}.',
        out_of_range: 'The route id {{id}} is outside the range 0-{{max}}.',
        ambiguous: 'The route id {{id}} is used by hosts of {{count}} different inbounds.',
      },
    },
    node: {
      'has-host': {
        no_host: 'No host points at this node: no host is assigned to it or has its address.',
      },
      'disabled-referenced': {
        last_server:
          'The node is disabled, and hosts that depend on it lead nowhere (hosts: {{count}}).',
        assigned: 'The node is disabled, but hosts are still assigned to it (hosts: {{count}}).',
      },
      'version-skew': {
        node_version: 'The node runs {{version}}; most nodes run {{common}}.',
        xray_version: 'Xray is {{version}} on this node; most nodes run {{common}}.',
        panel_line:
          'The node version {{version}} is not on the same release line as the panel {{panel}}.',
      },
      'address-valid': {
        invalid: 'The node address "{{address}}" is neither an IP address nor a valid host name.',
      },
      'profile-assigned': {
        none: 'The node has no config profile, so it serves nothing.',
        missing_profile: 'The node uses a config profile that does not exist.',
        no_inbounds: 'The node has a config profile but no active inbound, so it serves nothing.',
      },
      'plugin-exists': {
        missing: 'The node uses a node plugin that does not exist.',
      },
      'name-pattern': {
        mismatch: 'The node name "{{name}}" does not match the pattern {{pattern}}.',
      },
    },
    profile: {
      'inbound-tag-unique': {
        duplicate_in_profile: 'The tag "{{tag}}" is used by {{count}} inbounds of this profile.',
        duplicate_across_profiles:
          'The tag "{{tag}}" is also used in the profile "{{other}}"; tags must be unique across the panel.',
      },
      'inbound-port-clash': {
        clash: 'The inbounds {{tags}} listen on the same port {{port}}.',
      },
      'snippet-exists': {
        missing: 'The configuration uses the snippet "{{snippet}}", which does not exist.',
      },
      'name-pattern': {
        mismatch: 'The profile name "{{name}}" does not match the pattern {{pattern}}.',
      },
      unused: {
        unused: 'No node uses this profile.',
        no_inbounds: 'The profile has no inbounds.',
      },
      shared: {
        shared: 'Nodes that use this profile: {{count}}. Editing it restarts all of them.',
      },
    },
    squad: {
      'internal-empty': {
        no_inbounds: 'The squad has no inbounds, so its members get no servers.',
        no_members: 'The squad has no members.',
      },
      'inbound-exists': {
        missing: 'The squad lists the inbound "{{tag}}", which does not exist in any profile.',
      },
      'name-pattern': {
        mismatch: 'The squad name "{{name}}" does not match the pattern {{pattern}}.',
      },
      'external-template-exists': {
        missing_template:
          'The squad uses a subscription template of type {{type}} that does not exist.',
        type_mismatch:
          'The squad uses the template "{{template}}" as {{type}}, but that template is of type {{actual}}.',
      },
    },
    template: {
      'name-pattern': {
        mismatch: 'The template name "{{name}}" does not match the pattern {{pattern}}.',
      },
      'body-present': {
        unreadable:
          'The body of this {{type}} template is empty or could not be read as {{format}}.',
        not_loaded: 'The body of this {{type}} template was not read, so it was not checked.',
      },
      unused: {
        unused: 'No external squad and no host uses this template.',
      },
    },
    panel: {
      'token-expiry': {
        expiring: 'The API token of the connection expires in {{days}} days.',
        expired: 'The API token of the connection has expired.',
      },
    },
  },
  reconciliation: {
    checks: {
      host: {
        address: {
          title: 'Host address and node',
          description:
            'The address of a host is the address of the node that serves it, or an IP it resolves to (or what the pack says).',
        },
        sni: {
          title: 'Host SNI and node',
          description:
            'The SNI of a host is what the pack says (the address of the node), when the pack asks for it.',
        },
        port: {
          title: 'Host port and inbound',
          description: 'The port of a host is the port of its inbound, when the pack asks for it.',
        },
        node: {
          title: 'Host assigned nodes',
          description: 'The nodes a host is assigned to exist and serve the inbound of the host.',
        },
        duplicate: {
          title: 'Duplicate hosts',
          description: 'No two hosts have the same address, port, SNI and inbound.',
        },
      },
      node: {
        dns: {
          title: 'Node address and DNS',
          description:
            'The name of a node resolves (A and AAAA, following CNAME records) to addresses this installation allows; reports a long time to live.',
        },
        'disabled-resolving': {
          title: 'Disabled node that still resolves',
          description: 'A node that is disabled in the panel but whose name still resolves.',
        },
        duplicate: {
          title: 'Duplicate nodes',
          description: 'No two nodes share an address or an IP.',
        },
        server: {
          title: 'Node and server inventory',
          description:
            'Every node of the panel matches a server of the inventory (by address, by what the names resolve to, or by host name).',
        },
      },
      server: {
        node: {
          title: 'Server and panel',
          description:
            'Every server of the inventory that is not retired matches a node of the panel.',
        },
        duplicate: {
          title: 'Duplicate servers',
          description: 'No two servers of the inventory share an address or an IP.',
        },
      },
    },
    reasons: {
      address_matches_node: 'The address is the address of the node "{{node}}".',
      address_is_node_ip: 'The address is an IP of the node "{{node}}".',
      address_resolves_to_node: 'The address resolves to {{ip}}, an IP of the node "{{node}}".',
      address_differs:
        'The address {{address}} is not the address of the node "{{node}}" ({{expected}}) and does not resolve to one of its IPs.',
      address_not_ip:
        'The address {{address}} is a name; the pack wants an IP of the node "{{node}}".',
      address_not_node_ip:
        'The address {{address}} is not an IP of the node "{{node}}" ({{expected}}).',
      address_not_node_address:
        'The address {{address}} is not the address the panel has for the node "{{node}}" ({{expected}}).',
      no_serving_node:
        'No node serves the inbound of this host, so its address cannot be compared.',
      node_ip_unknown:
        'The IP of the node "{{node}}" is not known (its name did not resolve), so the address cannot be compared.',
      host_name_unresolved:
        'The name {{address}} could not be resolved, so it cannot be compared with the node "{{node}}".',
      sni_matches: 'The SNI is the address of the node "{{node}}".',
      sni_differs: 'The SNI {{sni}} is not the address of the node "{{node}}" ({{expected}}).',
      sni_missing:
        'The host has no SNI; the pack wants the address of the node "{{node}}" ({{expected}}).',
      node_address_is_ip:
        'The address of the node "{{node}}" is an IP, so there is no name to compare the SNI with.',
      port_matches: 'The port is the port of the inbound "{{tag}}".',
      port_differs: 'The port {{port}} is not the port {{expected}} of the inbound "{{tag}}".',
      inbound_port_unknown: 'The inbound "{{tag}}" has no single port to compare with.',
      assigned_nodes_serve: 'Every node the host is assigned to serves its inbound.',
      assigned_node_not_serving:
        'The host is assigned to the node "{{node}}", which does not serve its inbound.',
      assigned_node_missing: 'The host is assigned to a node that does not exist.',
      duplicate_host: 'Hosts with the same address, port, SNI and inbound: {{count}}.',
      resolves: '{{address}} resolves to {{ips}}.',
      resolves_high_ttl:
        '{{address}} resolves to {{ips}}; its time to live is {{ttl}} s, longer than {{max}} s, so a change takes that long to reach clients.',
      no_record: '{{address}} does not resolve: there is no A or AAAA record.',
      dns_timeout: 'The lookup of {{address}} timed out.',
      dns_error: 'The lookup of {{address}} failed.',
      dns_cname_loop: 'The CNAME chain of {{address}} is too long or loops.',
      dns_skipped_cap: 'Not looked up: this run looks up at most {{cap}} names.',
      dns_disabled: 'Name lookups are switched off in the pack.',
      resolves_to_refused_address:
        '{{address}} resolves to {{ip}}, an address this installation does not allow.',
      disabled_but_resolves: 'The node is disabled, but {{address}} still resolves to {{ips}}.',
      duplicate_address: 'Nodes that share the address or IP {{value}}: {{count}}.',
      matched_by_address: 'The server "{{server}}" has the same address.',
      matched_by_dns: 'The server "{{server}}" and the node resolve to the same IP {{ip}}.',
      matched_by_hostname:
        'The host name {{hostname}} of the node is the name, or the host name in the facts, of the server "{{server}}".',
      unmanaged: 'No server of the inventory matches this node.',
      match_undecided:
        'A name that did not resolve prevents deciding whether a server of the inventory matches this node.',
      ambiguous_servers: 'Servers that match this node: {{count}} ({{servers}}).',
      not_in_panel: 'The server is in the inventory, but no node of the panel matches it.',
      duplicate_server_address: 'Servers that share the address or IP {{value}}: {{count}}.',
    },
  },
  impact: {
    rules: {
      profile: {
        'config-edit':
          'Editing the configuration of a profile restarts Xray on every node that uses the profile, even when only one inbound changed.',
        'name-only': 'Renaming a profile or changing its tags restarts nothing.',
      },
      squad: {
        'inbounds-changed':
          'Changing the inbounds of an internal squad restarts the nodes that serve the added or removed inbounds.',
        'members-changed': 'Adding or removing members of a squad restarts no node.',
        'metadata-only': 'Renaming a squad or changing its tags restarts nothing.',
      },
      node: {
        'profile-move': 'Moving a node to another profile restarts that node and no other.',
        'active-inbounds-changed':
          'Changing the active inbounds of a node restarts that node and no other.',
        disable:
          'Disabling a node stops it: its users are disconnected, and no other node restarts.',
        enable: 'Enabling a node starts it; no other node restarts.',
        'connection-changed':
          'Changing the address or the port of a node makes the panel connect again, which restarts Xray on that node.',
        'metadata-only':
          'Changing the name, tags, note or other settings of a node that do not touch its connection or its profile restarts nothing.',
      },
      host: {
        edit: 'Editing a host restarts no node; the subscriptions that include the host change.',
      },
      template: {
        edit: 'Editing a subscription template restarts no node; the subscriptions that use it change.',
      },
    },
    risk: {
      no_effect: 'The change leaves the object as it is.',
      no_restart: 'No node restarts.',
      restarts_some: 'Nodes on which Xray restarts: {{count}} of {{total}} running.',
      restart_count_high:
        'Nodes that restart: {{count}}, at or above the limit of {{limit}} of this pack.',
      restart_share_high:
        '{{share}}% of the running nodes restart, at or above the limit of {{limit}}% of this pack.',
      shared_profile: 'The profile is shared by {{count}} nodes: they all restart together.',
      users_online: 'Users connected now to the nodes that restart: {{count}}.',
      dangling_refs: 'References that would point at an inbound that no longer exists: {{count}}.',
      hosts_unserved: 'Hosts that would be left with no node serving their inbound: {{count}}.',
      introduces_errors: 'The change would introduce convention errors: {{count}}.',
      introduces_warnings: 'The change would introduce convention warnings: {{count}}.',
      secret_changed: 'The change replaces a masked value: it touches a secret.',
      subscriptions_affected: 'The subscriptions that include the affected hosts change.',
    },
    safer: {
      clone_profile:
        'Clone the profile for the node (or the group of nodes) that needs the change, move only those nodes to the clone, and edit the clone: the {{others}} other nodes of the profile keep running untouched.',
    },
    notes: {
      ignored_fields:
        'These fields are not part of the editable form and were ignored: {{fields}}.',
      masked_kept: 'Masked values kept as they are: {{count}}.',
      secret_changed:
        'A masked value is replaced at {{paths}}: it counts as a change of a secret, and nothing of it is repeated here.',
      config_unavailable:
        'The configuration of the profile was not read, so a change of it cannot be compared with the current one.',
      unsupported_panel:
        'The panel runs {{version}}, outside the window the rules of this calculation were written for ({{range}}): the answer may not match its behaviour.',
      members_not_modelled:
        'Members of a squad are users, and the read model holds only their number: the members are not compared.',
      offline_nodes: 'Nodes that are offline and restart when they connect: {{count}}.',
      inbounds_renamed:
        'An inbound whose tag changes is a different inbound to the panel: hosts and squads that name the old one lose it.',
      node_inbounds_unknown:
        'Some active inbounds of the node are not among the inbounds of its new profile; they are dropped.',
      template_body_unreadable: 'The proposed template body is not valid {{format}}.',
      template_body_not_loaded:
        'The current body of this template was not read, so the calculation cannot tell whether the proposed body differs from it and counts the edit as a change.',
    },
  },
} as const;
