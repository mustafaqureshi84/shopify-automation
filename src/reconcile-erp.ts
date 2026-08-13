import { prisma, disconnect } from './db.js';
import { handleFatal } from './exit.js';
import { z } from 'zod';

const ERP_URL = process.env['ERP_URL'] ?? 'http://localhost:4000';

const ErpOrdersSchema = z.object({
  count: z.number(),
  orders: z.array(
    z.object({
      idempotencyKey: z.string(),
      reference: z.string(),
      orderGid: z.string(),
      at: z.string(),
    })
  ),
});

/**
 * The four disagreements between a local record and a remote system.
 *
 * Only `resolved-unknown` can be repaired from the local side alone: the
 * remote already has the work, so recording that fact is not doing it again.
 * The others need a decision — re-push, retry, or investigate — because
 * repairing them means performing work, not just recording it.
 */
type Verdict =
  | 'agreed'
  | 'missing-remote'
  | 'resolved-unknown'
  | 'confirmed-failed'
  | 'orphaned-remote';

interface Finding {
  verdict: Verdict;
  orderNumber: string;
  orderGid: string;
  key: string;
  localStatus: string;
  remoteReference: string | null;
  note: string;
}

async function fetchErpState(): Promise<Map<string, string>> {
  const res = await fetch(`${ERP_URL}/orders`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`ERP returned ${res.status} listing orders`);
  }

  const parsed = ErpOrdersSchema.safeParse(await res.json());

  if (!parsed.success) {
    throw new Error(
      `Unexpected ERP response shape: ${JSON.stringify(parsed.error.issues)}`
    );
  }

  return new Map(
    parsed.data.orders.map((o) => [o.idempotencyKey, o.reference])
  );
}

async function main(): Promise<void> {
  const repair = process.env['REPAIR'] === 'yes';

  const run = await prisma.reconciliationRun.create({ data: {} });

  console.log(`Reconciliation run ${run.id}`);
  console.log(`Mode: ${repair ? 'REPAIR' : 'report only'}\n`);

  try {
    const remote = await fetchErpState();

    console.log(`ERP holds ${remote.size} order(s)`);

    const local = await prisma.erpPush.findMany({
      where: { status: { in: ['confirmed', 'unknown'] } },
      include: { order: { select: { orderNumber: true } } },
      orderBy: { startedAt: 'desc' },
    });

    console.log(`Local has ${local.length} push(es) to check\n`);

    const findings: Finding[] = [];
    const seenKeys = new Set<string>();

    for (const push of local) {
      seenKeys.add(push.idempotencyKey);

      const remoteRef = remote.get(push.idempotencyKey) ?? null;

      const base = {
        orderNumber: push.order.orderNumber,
        orderGid: push.orderGid,
        key: push.idempotencyKey,
        localStatus: push.status,
        remoteReference: remoteRef,
      };

      if (push.status === 'confirmed' && remoteRef) {
        findings.push({
          ...base,
          verdict: 'agreed',
          note:
            remoteRef === push.erpReference
              ? 'references match'
              : `reference drift: local ${push.erpReference}, remote ${remoteRef}`,
        });
        continue;
      }

      if (push.status === 'confirmed' && !remoteRef) {
        findings.push({
          ...base,
          verdict: 'missing-remote',
          note: 'local believes this was pushed; the ERP has no record',
        });
        continue;
      }

      if (push.status === 'unknown' && remoteRef) {
        /**
         * The lost-response case. The push succeeded and the caller never
         * learned of it. This is the one disagreement repairable from here,
         * because the work is already done — recording it is not redoing it.
         */
        findings.push({
          ...base,
          verdict: 'resolved-unknown',
          note: `ERP has it as ${remoteRef} — the response was lost, not the work`,
        });
        continue;
      }

      findings.push({
        ...base,
        verdict: 'confirmed-failed',
        note: 'ERP does not have it; the push genuinely failed and can be retried',
      });
    }

    // Anything the remote holds that local has no record of sending.
    for (const [key, reference] of remote) {
      if (seenKeys.has(key)) continue;

      findings.push({
        verdict: 'orphaned-remote',
        orderNumber: '(unknown)',
        orderGid: '(unknown)',
        key,
        localStatus: '(none)',
        remoteReference: reference,
        note: 'ERP has an order this system has no record of sending',
      });
    }

    const counts = new Map<Verdict, number>();
    for (const f of findings) {
      counts.set(f.verdict, (counts.get(f.verdict) ?? 0) + 1);
    }

    console.log('=== Findings ===\n');

    for (const f of findings) {
      const marker = f.verdict === 'agreed' ? ' ' : '!';
      console.log(`${marker} ${f.orderNumber} — ${f.verdict}`);
      console.log(`    local:  ${f.localStatus}`);
      console.log(`    remote: ${f.remoteReference ?? '(absent)'}`);
      console.log(`    ${f.note}\n`);
    }

    let repaired = 0;

    if (repair) {
      const resolvable = findings.filter((f) => f.verdict === 'resolved-unknown');

      if (resolvable.length === 0) {
        console.log('Nothing safely repairable.\n');
      } else {
        console.log(`Repairing ${resolvable.length} resolved-unknown push(es)...\n`);

        for (const f of resolvable) {
          await prisma.erpPush.update({
            where: { idempotencyKey: f.key },
            data: {
              status: 'confirmed',
              erpReference: f.remoteReference,
              completedAt: new Date(),
              error: null,
            },
          });

          console.log(`  ${f.orderNumber} -> confirmed as ${f.remoteReference}`);
          repaired += 1;
        }
        console.log('');
      }
    }

    await prisma.reconciliationRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        pushesChecked: local.length,
        agreed: counts.get('agreed') ?? 0,
        missingRemote: counts.get('missing-remote') ?? 0,
        resolvedUnknown: counts.get('resolved-unknown') ?? 0,
        confirmedFailed: counts.get('confirmed-failed') ?? 0,
        orphanedRemote: counts.get('orphaned-remote') ?? 0,
        repaired,
      },
    });

    console.log('=== Summary ===\n');
    console.log(`  agreed             ${counts.get('agreed') ?? 0}`);
    console.log(`  missing-remote     ${counts.get('missing-remote') ?? 0}`);
    console.log(`  resolved-unknown   ${counts.get('resolved-unknown') ?? 0}`);
    console.log(`  confirmed-failed   ${counts.get('confirmed-failed') ?? 0}`);
    console.log(`  orphaned-remote    ${counts.get('orphaned-remote') ?? 0}`);
    console.log(`  repaired           ${repaired}`);

    const needsHuman =
      (counts.get('missing-remote') ?? 0) + (counts.get('orphaned-remote') ?? 0);

    if (needsHuman > 0) {
      console.log(`\n${needsHuman} finding(s) cannot be repaired automatically.`);
      console.log(
        'Re-pushing a missing-remote order means doing work, not recording it —'
      );
      console.log('that decision belongs to a human, not a reconciliation script.');
    }

    if (!repair && (counts.get('resolved-unknown') ?? 0) > 0) {
      console.log('\nRerun with REPAIR=yes to resolve the unknown pushes.');
    }
  } catch (err) {
    await prisma.reconciliationRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  } finally {
    await disconnect();
  }
}

main().catch(handleFatal);