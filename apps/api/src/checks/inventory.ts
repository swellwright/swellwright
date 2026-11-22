import { Inject, Injectable } from '@nestjs/common';
import type { InventoryServer } from '@swellwright/conventions';
import type { Database } from '@swellwright/db';

import { requireDatabase } from '../auth/context.js';
import { DATABASE } from '../tokens.js';

/**
 * The servers of the inventory (ADR 0034) as far as reconciliation needs them: what SSH connects to, the state, the tags
 * and the host name the last facts reported. Read only, and never a secret: access entries are not touched.
 */
@Injectable()
export class InventoryReader {
  constructor(@Inject(DATABASE) private readonly database: Database | undefined) {}

  async list(): Promise<InventoryServer[]> {
    const rows = await requireDatabase(this.database).client.server.findMany({
      select: {
        id: true,
        name: true,
        address: true,
        state: true,
        tags: true,
        fact: { select: { facts: true } },
      },
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => {
      const facts = row.fact?.facts;
      const hostname =
        typeof facts === 'object' && facts !== null && !Array.isArray(facts)
          ? facts['hostname']
          : null;
      return {
        id: row.id,
        name: row.name,
        address: row.address,
        state: row.state,
        tags: row.tags,
        hostname:
          typeof hostname === 'string' && hostname.trim() !== '' ? hostname.slice(0, 255) : null,
      };
    });
  }
}
