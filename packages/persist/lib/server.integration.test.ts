import { expect, describe, it, beforeAll, afterAll, vi } from 'vitest';
import { server } from './server.js';
import fetch from 'node-fetch';
import type { AuthCredentials, Connection, Sync, Job as SyncJob, Environment, Account } from '@nangohq/shared';
import {
    multipleMigrations,
    createActivityLog,
    environmentService,
    connectionService,
    createSync,
    createSyncJob,
    SyncType,
    SyncStatus,
    db,
    accountService
} from '@nangohq/shared';
import { logContextGetter } from '@nangohq/logs';
import { migrate as migrateRecords } from '@nangohq/records';

const mockSecretKey = 'secret-key';

describe('Persist API', () => {
    const port = 3096;
    const serverUrl = `http://localhost:${port}`;
    let seed: {
        account: Account;
        env: Environment;
        activityLogId: number;
        connection: Connection;
        sync: Sync;
        syncJob: SyncJob;
    };

    beforeAll(async () => {
        await multipleMigrations();
        await migrateRecords();
        seed = await initDb();
        server.listen(port);

        vi.spyOn(environmentService, 'getAccountAndEnvironmentBySecretKey').mockImplementation((secretKey) => {
            if (secretKey === mockSecretKey) {
                return Promise.resolve({ account: seed.account, environment: seed.env });
            }
            return Promise.resolve(null);
        });
    });

    afterAll(async () => {
        await clearDb();
    });

    it('should server /health', async () => {
        const response = await fetch(`${serverUrl}/health`);
        expect(response.status).toEqual(200);
        expect(await response.json()).toEqual({ status: 'ok' });
    });

    it('should log', async () => {
        const response = await fetch(`${serverUrl}/environment/${seed.env.id}/log`, {
            method: 'POST',
            body: JSON.stringify({ activityLogId: seed.activityLogId, level: 'info', msg: 'Hello, world!' }),
            headers: {
                Authorization: `Bearer ${mockSecretKey}`,
                'Content-Type': 'application/json'
            }
        });
        expect(response.status).toEqual(201);
    });

    it('should refuse huge log', async () => {
        const msg: number[] = [];

        for (let index = 0; index < 150_000; index++) {
            msg.push(index);
        }
        const response = await fetch(`${serverUrl}/environment/${seed.env.id}/log`, {
            method: 'POST',
            body: JSON.stringify({ activityLogId: seed.activityLogId, level: 'info', msg: msg.join(',') }),
            headers: {
                Authorization: `Bearer ${mockSecretKey}`,
                'Content-Type': 'application/json'
            }
        });
        expect(response.status).toEqual(400);
        expect(await response.json()).toStrictEqual({ error: 'Entity too large' });
    });

    describe('save records', () => {
        it('should error if no records', async () => {
            const response = await fetch(
                `${serverUrl}/environment/${seed.env.id}/connection/${seed.connection.id}/sync/${seed.sync.id}/job/${seed.syncJob.id}/records`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        model: 'MyModel',
                        records: [],
                        providerConfigKey: seed.connection.provider_config_key,
                        connectionId: seed.connection.connection_id,
                        lastSyncDate: new Date(),
                        trackDeletes: false,
                        softDelete: true,
                        activityLogId: seed.activityLogId
                    }),
                    headers: {
                        Authorization: `Bearer ${mockSecretKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            expect(response.status).toEqual(400);
            const respBody = (await response.json()) as any[];
            expect(respBody).toMatchObject([
                {
                    type: 'Body',
                    errors: {
                        issues: [
                            {
                                code: 'too_small',
                                minimum: 1,
                                type: 'array',
                                message: 'Array must contain at least 1 element(s)',
                                path: ['records']
                            }
                        ],
                        name: 'ZodError'
                    }
                }
            ]);
        });

        it('should save records', async () => {
            const model = 'MyModel';
            const records = [
                { id: 1, name: 'r1' },
                { id: 2, name: 'r2' }
            ];
            const response = await fetch(
                `${serverUrl}/environment/${seed.env.id}/connection/${seed.connection.id}/sync/${seed.sync.id}/job/${seed.syncJob.id}/records`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        model,
                        records: records,
                        providerConfigKey: seed.connection.provider_config_key,
                        connectionId: seed.connection.connection_id,
                        activityLogId: seed.activityLogId,
                        lastSyncDate: new Date(),
                        trackDeletes: false
                    }),
                    headers: {
                        Authorization: `Bearer ${mockSecretKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            expect(response.status).toEqual(201);
        });
    });

    it('should delete records ', async () => {
        const model = 'MyModel';
        const records = [
            { id: 1, name: 'r1' },
            { id: 2, name: 'r2' }
        ];
        const response = await fetch(
            `${serverUrl}/environment/${seed.env.id}/connection/${seed.connection.id}/sync/${seed.sync.id}/job/${seed.syncJob.id}/records`,
            {
                method: 'DELETE',
                body: JSON.stringify({
                    model,
                    records: records,
                    providerConfigKey: seed.connection.provider_config_key,
                    connectionId: seed.connection.connection_id,
                    activityLogId: seed.activityLogId,
                    lastSyncDate: new Date(),
                    trackDeletes: false
                }),
                headers: {
                    Authorization: `Bearer ${mockSecretKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        expect(response.status).toEqual(201);
    });

    it('should update records ', async () => {
        const model = 'MyModel';
        const records = [
            { id: 1, name: 'new1' },
            { id: 2, name: 'new2' }
        ];
        const response = await fetch(
            `${serverUrl}/environment/${seed.env.id}/connection/${seed.connection.id}/sync/${seed.sync.id}/job/${seed.syncJob.id}/records`,
            {
                method: 'PUT',
                body: JSON.stringify({
                    model,
                    records: records,
                    providerConfigKey: seed.connection.provider_config_key,
                    connectionId: seed.connection.connection_id,
                    activityLogId: seed.activityLogId,
                    lastSyncDate: new Date(),
                    trackDeletes: false,
                    softDelete: true
                }),
                headers: {
                    Authorization: `Bearer ${mockSecretKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        expect(response.status).toEqual(201);
    });

    it('should fail if passing incorrect authorization header ', async () => {
        const recordsUrl = `${serverUrl}/environment/${seed.env.id}/connection/${seed.connection.id}/sync/${seed.sync.id}/job/${seed.syncJob.id}/records`;
        const reqs = [`POST ${serverUrl}/environment/${seed.env.id}/log`, `POST ${recordsUrl}`, `PUT ${recordsUrl}`, `DELETE ${recordsUrl}`];

        for (const req of reqs) {
            const [method, url] = req.split(' ');
            if (method && url) {
                const res = await fetch(url, {
                    method,
                    headers: { Authorization: `Bearer WRONG_SECRET_KEY` }
                });
                expect(res.status).toEqual(401);
            } else {
                throw new Error('Invalid request');
            }
        }
    });
});

const initDb = async () => {
    const env = await environmentService.createEnvironment(0, 'testEnv');
    if (!env) throw new Error('Environment not created');
    const activityLogId = await createActivityLog({
        environment_id: env.id,
        level: 'info',
        action: 'sync',
        success: null,
        timestamp: Date.now(),
        start: Date.now(),
        connection_id: null,
        provider_config_key: null
    });
    if (!activityLogId) {
        throw new Error('Activity log not created');
    }

    await logContextGetter.create(
        { id: String(activityLogId), operation: { type: 'sync', action: 'run' }, message: 'Sync' },
        { account: { id: env.account_id }, environment: { id: env.id } }
    );

    const connectionRes = await connectionService.upsertConnection(`conn-test`, `provider-test`, 'google', {} as AuthCredentials, {}, env.id, 0);
    const connectionId = connectionRes[0]?.id;
    if (!connectionId) throw new Error('Connection not created');

    const connection = (await connectionService.getConnectionById(connectionId)) as Connection;
    if (!connection) throw new Error('Connection not found');

    const sync = await createSync(connectionId, 'sync-test');
    if (!sync?.id) throw new Error('Sync not created');

    const syncJob = (await createSyncJob(sync.id, SyncType.INITIAL, SyncStatus.RUNNING, `job-test`, connection)) as SyncJob;
    if (!syncJob) throw new Error('Sync job not created');

    return {
        account: (await accountService.getAccountById(0))!,
        env,
        activityLogId,
        connection,
        sync,
        syncJob
    };
};

const clearDb = async () => {
    await db.knex.raw(`DROP SCHEMA nango CASCADE`);
};
