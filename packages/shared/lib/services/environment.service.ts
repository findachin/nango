import * as uuid from 'uuid';
import db from '../db/database.js';
import encryptionManager, { ENCRYPTION_KEY, pbkdf2 } from '../utils/encryption.manager.js';
import type { Environment } from '../models/Environment.js';
import type { EnvironmentVariable } from '../models/EnvironmentVariable.js';
import type { Account } from '../models/Admin.js';
import { LogActionEnum } from '../models/Activity.js';
import accountService from './account.service.js';
import errorManager, { ErrorSourceEnum } from '../utils/error.manager.js';
import { isCloud } from '@nangohq/utils';

const TABLE = '_nango_environments';

export const defaultEnvironments = ['prod', 'dev'];

const hashLocalCache = new Map<string, string>();

class EnvironmentService {
    async getEnvironmentsByAccountId(account_id: number): Promise<Pick<Environment, 'name'>[]> {
        try {
            const result = await db.knex.select<Pick<Environment, 'name'>[]>('name').from<Environment>(TABLE).where({ account_id });

            if (result == null || result.length == 0) {
                return [];
            }

            return result;
        } catch (e) {
            errorManager.report(e, {
                source: ErrorSourceEnum.PLATFORM,
                operation: LogActionEnum.DATABASE,
                accountId: account_id
            });

            return [];
        }
    }

    async getAccountAndEnvironmentBySecretKey(secretKey: string): Promise<{ account: Account; environment: Environment } | null> {
        if (!isCloud) {
            const environmentVariables = Object.keys(process.env).filter((key) => key.startsWith('NANGO_SECRET_KEY_'));
            if (environmentVariables.length > 0) {
                for (const environmentVariable of environmentVariables) {
                    const envSecretKey = process.env[environmentVariable] as string;

                    if (envSecretKey !== secretKey) {
                        continue;
                    }

                    const envName = environmentVariable.replace('NANGO_SECRET_KEY_', '').toLowerCase();
                    // This key is set dynamically and does not exists in database
                    const env = await db.knex.select<Pick<Environment, 'account_id'>>('account_id').from<Environment>(TABLE).where({ name: envName }).first();

                    if (!env) {
                        return null;
                    }

                    return this.getAccountAndEnvironment({ accountId: env.account_id, envName });
                }
            }
        }

        return this.getAccountAndEnvironment({ secretKey });
    }

    async getAccountIdFromEnvironment(environment_id: number): Promise<number | null> {
        const result = await db.knex.select('account_id').from<Environment>(TABLE).where({ id: environment_id });

        if (result == null || result.length == 0 || result[0] == null) {
            return null;
        }

        return result[0].account_id;
    }

    async getAccountFromEnvironment(environment_id: number): Promise<Account | null> {
        const result = await db.knex
            .select<Account>('_nango_accounts.*')
            .from(TABLE)
            .join('_nango_accounts', '_nango_accounts.id', '_nango_environments.account_id')
            .where('_nango_environments.id', environment_id)
            .first();

        return result || null;
    }

    async getAccountUUIDFromEnvironmentUUID(environment_uuid: string): Promise<string | null> {
        const result = await db.knex.select('account_id').from<Environment>(TABLE).where({ uuid: environment_uuid });

        if (result == null || result.length == 0 || result[0] == null) {
            return null;
        }

        const accountId = result[0].account_id;

        const uuid = await accountService.getUUIDFromAccountId(accountId);

        return uuid;
    }

    async getAccountAndEnvironmentByPublicKey(publicKey: string): Promise<{ account: Account; environment: Environment } | null> {
        if (!isCloud) {
            const environmentVariables = Object.keys(process.env).filter((key) => key.startsWith('NANGO_PUBLIC_KEY_'));
            if (environmentVariables.length > 0) {
                for (const environmentVariable of environmentVariables) {
                    const envPublicKey = process.env[environmentVariable] as string;

                    if (envPublicKey !== publicKey) {
                        continue;
                    }
                    const envName = environmentVariable.replace('NANGO_PUBLIC_KEY_', '').toLowerCase();
                    // This key is set dynamically and does not exists in database
                    const env = await db.knex.select<Pick<Environment, 'account_id'>>('account_id').from<Environment>(TABLE).where({ name: envName }).first();
                    if (!env) {
                        return null;
                    }

                    return this.getAccountAndEnvironment({ accountId: env.account_id, envName });
                }
            }
        }

        return this.getAccountAndEnvironment({ publicKey });
    }

    async getAccountAndEnvironment(
        opts: { publicKey: string } | { secretKey: string } | { accountId: number; envName: string }
    ): Promise<{ account: Account; environment: Environment } | null> {
        const q = db.knex
            .select<{
                account: Account;
                environment: Environment;
            }>(db.knex.raw('row_to_json(_nango_environments.*) as environment'), db.knex.raw('row_to_json(_nango_accounts.*) as account'))
            .from<Environment>(TABLE)
            .join('_nango_accounts', '_nango_accounts.id', '_nango_environments.account_id')
            .first();

        let hash: string | undefined;
        if ('secretKey' in opts) {
            // Hashing is slow by design so it's very slow to recompute this hash all the time
            // We keep the hash in-memory to not compromise on security if the db leak
            hash = hashLocalCache.get(opts.secretKey) || (await hashSecretKey(opts.secretKey));
            q.where('secret_key_hashed', hash);
        } else if ('publicKey' in opts) {
            q.where('_nango_environments.public_key', opts.publicKey);
        } else if (opts.accountId !== undefined) {
            q.where('_nango_environments.account_id', opts.accountId).where('_nango_environments.name', opts.envName);
        } else {
            return null;
        }

        const res = await q;
        if (!res) {
            return null;
        }

        if (hash && 'secretKey' in opts) {
            // Store only successful attempt to not pollute the memory
            hashLocalCache.set(opts.secretKey, hash);
        }
        return { account: res.account, environment: encryptionManager.decryptEnvironment(res.environment)! };
    }

    async getIdByUuid(uuid: string): Promise<number | null> {
        const result = await db.knex.select('id').from<Environment>(TABLE).where({ uuid });

        if (result == null || result.length == 0 || result[0] == null) {
            return null;
        }

        return result[0].id;
    }

    async getById(id: number): Promise<Environment | null> {
        try {
            const result = await db.knex.select('*').from<Environment>(TABLE).where({ id });

            if (result == null || result.length == 0 || result[0] == null) {
                return null;
            }

            return encryptionManager.decryptEnvironment(result[0]);
        } catch (e) {
            errorManager.report(e, {
                environmentId: id,
                source: ErrorSourceEnum.PLATFORM,
                operation: LogActionEnum.DATABASE,
                metadata: {
                    id
                }
            });
            return null;
        }
    }

    async getRawById(id: number): Promise<Environment | null> {
        try {
            const result = await db.knex.select('*').from<Environment>(TABLE).where({ id });

            if (result == null || result.length == 0 || result[0] == null) {
                return null;
            }

            return result[0];
        } catch (e) {
            errorManager.report(e, {
                environmentId: id,
                source: ErrorSourceEnum.PLATFORM,
                operation: LogActionEnum.DATABASE,
                metadata: {
                    id
                }
            });
            return null;
        }
    }

    async getByEnvironmentName(accountId: number, name: string): Promise<Environment | null> {
        const result = await db.knex.select('*').from<Environment>(TABLE).where({ account_id: accountId, name });

        if (result == null || result.length == 0 || result[0] == null) {
            return null;
        }

        return encryptionManager.decryptEnvironment(result[0]);
    }

    async createEnvironment(accountId: number, environment: string): Promise<Environment | null> {
        const result = await db.knex.from<Environment>(TABLE).insert({ account_id: accountId, name: environment }).returning('id');

        if (Array.isArray(result) && result.length === 1 && result[0] && 'id' in result[0]) {
            const environmentId = result[0]['id'];
            const environment = await this.getById(environmentId);
            if (!environment) {
                return null;
            }

            const encryptedEnvironment = encryptionManager.encryptEnvironment({
                ...environment,
                secret_key_hashed: await hashSecretKey(environment.secret_key)
            });
            await db.knex.from<Environment>(TABLE).where({ id: environmentId }).update(encryptedEnvironment);

            const env = encryptionManager.decryptEnvironment(encryptedEnvironment)!;
            return env;
        }

        return null;
    }

    async createDefaultEnvironments(accountId: number): Promise<void> {
        for (const environment of defaultEnvironments) {
            await this.createEnvironment(accountId, environment);
        }
    }

    async getEnvironmentName(id: number): Promise<string | null> {
        const result = await db.knex.select('name').from<Environment>(TABLE).where({ id });

        if (result == null || result.length == 0 || result[0] == null) {
            return null;
        }

        return result[0].name;
    }

    /**
     * Get Environment Id For Account Assuming Prod
     * @desc legacy function to get the environment id for an account assuming prod
     * while the transition is being made from account_id to environment_id
     */
    async getEnvironmentIdForAccountAssumingProd(accountId: number): Promise<number | null> {
        const result = await db.knex.select('id').from<Environment>(TABLE).where({ account_id: accountId, name: 'prod' });

        if (result == null || result.length == 0 || result[0] == null) {
            return null;
        }

        return result[0].id;
    }

    async editCallbackUrl(callbackUrl: string, id: number): Promise<Environment | null> {
        return db.knex.from<Environment>(TABLE).where({ id }).update({ callback_url: callbackUrl }, ['id']);
    }

    async editWebhookUrl(webhookUrl: string, id: number): Promise<Environment | null> {
        return db.knex.from<Environment>(TABLE).where({ id }).update({ webhook_url: webhookUrl }, ['id']);
    }

    async editHmacEnabled(hmacEnabled: boolean, id: number): Promise<Environment | null> {
        return db.knex.from<Environment>(TABLE).where({ id }).update({ hmac_enabled: hmacEnabled }, ['id']);
    }

    async editAlwaysSendWebhook(always_send_webhook: boolean, id: number): Promise<Environment | null> {
        return db.knex.from<Environment>(TABLE).where({ id }).update({ always_send_webhook }, ['id']);
    }

    async editSendAuthWebhook(send_auth_webhook: boolean, id: number): Promise<Environment | null> {
        return db.knex.from<Environment>(TABLE).where({ id }).update({ send_auth_webhook }, ['id']);
    }

    async editSlackNotifications(slack_notifications: boolean, id: number): Promise<Environment | null> {
        return db.knex.from<Environment>(TABLE).where({ id }).update({ slack_notifications }, ['id']);
    }

    async getSlackNotificationsEnabled(environmentId: number): Promise<boolean | null> {
        const result = await db.knex.select('slack_notifications').from<Environment>(TABLE).where({ id: environmentId });

        if (result == null || result.length == 0 || result[0] == null) {
            return null;
        }

        return result[0].slack_notifications;
    }

    async editHmacKey(hmacKey: string, id: number): Promise<Environment | null> {
        return db.knex.from<Environment>(TABLE).where({ id }).update({ hmac_key: hmacKey }, ['id']);
    }

    async getEnvironmentVariables(environment_id: number): Promise<EnvironmentVariable[] | null> {
        const result = await db.knex.select('*').from<EnvironmentVariable>(`_nango_environment_variables`).where({ environment_id });

        if (result === null || result.length === 0) {
            return [];
        }

        return encryptionManager.decryptEnvironmentVariables(result);
    }

    async editEnvironmentVariable(environment_id: number, values: { name: string; value: string }[]): Promise<number[] | null> {
        await db.knex.from<EnvironmentVariable>(`_nango_environment_variables`).where({ environment_id }).del();

        if (values.length === 0) {
            return null;
        }

        const mappedValues: EnvironmentVariable[] = values.map((value) => {
            return {
                ...value,
                environment_id
            };
        });

        const encryptedValues = encryptionManager.encryptEnvironmentVariables(mappedValues);

        const results = await db.knex.from<EnvironmentVariable>(`_nango_environment_variables`).where({ environment_id }).insert(encryptedValues);

        if (results === null || results.length === 0) {
            return null;
        }

        return results;
    }

    async rotateKey(id: number, type: string): Promise<string | null> {
        if (type === 'secret') {
            return this.rotateSecretKey(id);
        }

        if (type === 'public') {
            return this.rotatePublicKey(id);
        }

        return null;
    }

    async revertKey(id: number, type: string): Promise<string | null> {
        if (type === 'secret') {
            return this.revertSecretKey(id);
        }

        if (type === 'public') {
            return this.revertPublicKey(id);
        }

        return null;
    }

    async activateKey(id: number, type: string): Promise<boolean> {
        if (type === 'secret') {
            return this.activateSecretKey(id);
        }

        if (type === 'public') {
            return this.activatePublicKey(id);
        }

        return false;
    }

    async rotateSecretKey(id: number): Promise<string | null> {
        const environment = await this.getById(id);

        if (!environment) {
            return null;
        }

        const pending_secret_key = uuid.v4();

        await db.knex.from<Environment>(TABLE).where({ id }).update({ pending_secret_key });

        environment.pending_secret_key = pending_secret_key;

        const encryptedEnvironment = encryptionManager.encryptEnvironment(environment);
        await db.knex.from<Environment>(TABLE).where({ id }).update(encryptedEnvironment);

        return pending_secret_key;
    }

    async rotatePublicKey(id: number): Promise<string | null> {
        const pending_public_key = uuid.v4();

        await db.knex.from<Environment>(TABLE).where({ id }).update({ pending_public_key });

        return pending_public_key;
    }

    async revertSecretKey(id: number): Promise<string | null> {
        const environment = await this.getById(id);

        if (!environment) {
            return null;
        }

        await db.knex.from<Environment>(TABLE).where({ id }).update({
            pending_secret_key: null,
            pending_secret_key_iv: null,
            pending_secret_key_tag: null
        });

        return environment.secret_key;
    }

    async revertPublicKey(id: number): Promise<string | null> {
        const environment = await this.getById(id);

        if (!environment) {
            return null;
        }

        await db.knex.from<Environment>(TABLE).where({ id }).update({ pending_public_key: null });

        return environment.public_key;
    }

    async activateSecretKey(id: number): Promise<boolean> {
        const environment = await this.getRawById(id);

        if (!environment) {
            return false;
        }

        const decrypted = encryptionManager.decryptEnvironment(environment)!;
        await db.knex
            .from<Environment>(TABLE)
            .where({ id })
            .update({
                secret_key: environment.pending_secret_key as string,
                secret_key_iv: environment.pending_secret_key_iv as string,
                secret_key_tag: environment.pending_secret_key_tag as string,
                secret_key_hashed: await hashSecretKey(decrypted.pending_secret_key!),
                pending_secret_key: null,
                pending_secret_key_iv: null,
                pending_secret_key_tag: null
            });

        const updatedEnvironment = await this.getById(id);

        if (!updatedEnvironment) {
            return false;
        }

        return true;
    }

    async activatePublicKey(id: number): Promise<boolean> {
        const environment = await this.getById(id);

        if (!environment) {
            return false;
        }

        await db.knex
            .from<Environment>(TABLE)
            .where({ id })
            .update({
                public_key: environment.pending_public_key as string,
                pending_public_key: null
            });

        return true;
    }
}

export async function hashSecretKey(key: string) {
    if (!ENCRYPTION_KEY) {
        return key;
    }

    return (await pbkdf2(key, ENCRYPTION_KEY, 310000, 32, 'sha256')).toString('base64');
}

export default new EnvironmentService();
