import type { Request, Response, NextFunction } from 'express';
import type { Span } from 'dd-trace';
import type { LogLevel, NangoConnection, HTTP_VERB, Connection, IncomingFlowConfig } from '@nangohq/shared';
import tracer from 'dd-trace';
import {
    deploy as deploySyncConfig,
    connectionService,
    getSyncs,
    verifyOwnership,
    isSyncValid,
    getSyncNamesByConnectionId,
    getSyncsByProviderConfigKey,
    SyncClient,
    updateScheduleStatus,
    updateSuccess as updateSuccessActivityLog,
    createActivityLogMessageAndEnd,
    createActivityLog,
    getAndReconcileDifferences,
    getSyncConfigsWithConnectionsByEnvironmentId,
    getProviderConfigBySyncAndAccount,
    SyncCommand,
    CommandToActivityLog,
    errorManager,
    analytics,
    AnalyticsTypes,
    ErrorSourceEnum,
    LogActionEnum,
    NangoError,
    configService,
    syncOrchestrator,
    getAttributes,
    flowService,
    getActionOrModelByEndpoint,
    getSyncsBySyncConfigId,
    updateFrequency,
    updateSyncScheduleFrequency,
    getInterval,
    findSyncByConnections,
    setFrequency,
    getSyncAndActionConfigsBySyncNameAndConfigId,
    createActivityLogMessage,
    trackFetch,
    syncCommandToOperation
} from '@nangohq/shared';
import type { LogContext } from '@nangohq/logs';
import { logContextGetter } from '@nangohq/logs';
import { isErr, isOk } from '@nangohq/utils';
import type { LastAction } from '@nangohq/records';
import { records as recordsService } from '@nangohq/records';
import type { RequestLocals } from '../utils/express.js';

class SyncController {
    public async deploySync(req: Request, res: Response<any, Required<RequestLocals>>, next: NextFunction) {
        try {
            const {
                syncs,
                reconcile,
                debug,
                singleDeployMode
            }: { syncs: IncomingFlowConfig[]; reconcile: boolean; debug: boolean; singleDeployMode?: boolean } = req.body;
            const environmentId = res.locals['environment'].id;
            let reconcileSuccess = true;

            const {
                success,
                error,
                response: syncConfigDeployResult
            } = await deploySyncConfig(environmentId, syncs, req.body.nangoYamlBody || '', logContextGetter, debug);

            if (!success) {
                errorManager.errResFromNangoErr(res, error);

                return;
            }

            if (reconcile) {
                const logCtx = logContextGetter.get({ id: String(syncConfigDeployResult?.activityLogId) });
                const success = await getAndReconcileDifferences({
                    environmentId,
                    syncs,
                    performAction: reconcile,
                    activityLogId: syncConfigDeployResult?.activityLogId as number,
                    debug,
                    singleDeployMode,
                    logCtx,
                    logContextGetter
                });
                if (!success) {
                    reconcileSuccess = false;
                }
            }

            if (!reconcileSuccess) {
                res.status(500).send({ message: 'There was an error deploying syncs, please check the activity tab and report this issue to support' });

                return;
            }

            void analytics.trackByEnvironmentId(AnalyticsTypes.SYNC_DEPLOY_SUCCESS, environmentId);

            res.send(syncConfigDeployResult?.result);
        } catch (e) {
            const environmentId = res.locals['environment'].id;

            errorManager.report(e, {
                source: ErrorSourceEnum.PLATFORM,
                environmentId,
                operation: LogActionEnum.SYNC_DEPLOY
            });

            next(e);
        }
    }

    public async confirmation(req: Request, res: Response<any, Required<RequestLocals>>, next: NextFunction) {
        try {
            const { syncs, debug, singleDeployMode }: { syncs: IncomingFlowConfig[]; reconcile: boolean; debug: boolean; singleDeployMode?: boolean } =
                req.body;
            const environmentId = res.locals['environment'].id;

            const result = await getAndReconcileDifferences({
                environmentId,
                syncs,
                performAction: false,
                activityLogId: null,
                debug,
                singleDeployMode,
                logContextGetter
            });

            res.send(result);
        } catch (e) {
            next(e);
        }
    }

    public async getAllRecords(req: Request, res: Response<any, Required<RequestLocals>>, next: NextFunction) {
        try {
            const { model, delta, modified_after, modifiedAfter, limit, filter, cursor, next_cursor } = req.query;
            const environmentId = res.locals['environment'].id;
            const connectionId = req.get('Connection-Id') as string;
            const providerConfigKey = req.get('Provider-Config-Key') as string;

            if (modifiedAfter) {
                const error = new NangoError('incorrect_param', { incorrect: 'modifiedAfter', correct: 'modified_after' });

                errorManager.errResFromNangoErr(res, error);
                return;
            }

            if (next_cursor) {
                const error = new NangoError('incorrect_param', { incorrect: 'next_cursor', correct: 'cursor' });

                errorManager.errResFromNangoErr(res, error);
                return;
            }

            const { error, response: connection } = await connectionService.getConnection(connectionId, providerConfigKey, environmentId);

            if (error || !connection) {
                const nangoError = new NangoError('unknown_connection', { connectionId, providerConfigKey, environmentId });
                errorManager.errResFromNangoErr(res, nangoError);
                return;
            }

            const result = await recordsService.getRecords({
                connectionId: connection.id as number,
                model: model as string,
                modifiedAfter: (delta || modified_after) as string,
                limit: limit as string,
                filter: filter as LastAction,
                cursor: cursor as string
            });

            if (isErr(result)) {
                errorManager.errResFromNangoErr(res, new NangoError('pass_through_error', result.err));
                return;
            }
            await trackFetch(connection.id as number);
            res.send(result.res);
        } catch (e) {
            next(e);
        }
    }

    public async getSyncsByParams(req: Request, res: Response<any, Required<RequestLocals>>, next: NextFunction) {
        try {
            const { environment } = res.locals;
            const { connection_id, provider_config_key } = req.query;

            const {
                success,
                error,
                response: connection
            } = await connectionService.getConnection(connection_id as string, provider_config_key as string, environment.id);

            if (!success) {
                errorManager.errResFromNangoErr(res, error);

                return;
            }

            if (!connection) {
                const error = new NangoError('unknown_connection', { connection_id, provider_config_key, environmentName: environment.name });
                errorManager.errResFromNangoErr(res, error);

                return;
            }

            const syncs = await getSyncs(connection);

            res.send(syncs);
        } catch (e) {
            next(e);
        }
    }

    public async getSyncs(_: Request, res: Response<any, Required<RequestLocals>>, next: NextFunction) {
        try {
            const { environment } = res.locals;

            const syncs = await getSyncConfigsWithConnectionsByEnvironmentId(environment.id);
            const flows = flowService.getAllAvailableFlows();

            res.send({ syncs, flows });
        } catch (e) {
            next(e);
        }
    }

    public async trigger(req: Request, res: Response<any, Required<RequestLocals>>, next: NextFunction) {
        try {
            const { syncs: syncNames, full_resync } = req.body;

            const provider_config_key: string | undefined = req.body.provider_config_key || req.get('Provider-Config-Key');
            if (!provider_config_key) {
                res.status(400).send({ message: 'Missing provider config key' });

                return;
            }

            const connection_id: string | undefined = req.body.connection_id || req.get('Connection-Id');

            if (typeof syncNames === 'string') {
                res.status(400).send({ message: 'Syncs must be an array' });

                return;
            }

            if (!syncNames) {
                res.status(400).send({ message: 'Missing sync names' });

                return;
            }

            if (full_resync && typeof full_resync !== 'boolean') {
                res.status(400).send({ message: 'full_resync must be a boolean' });
                return;
            }

            const environmentId = res.locals['environment'].id;

            const { success, error } = await syncOrchestrator.runSyncCommand({
                recordsService,
                environmentId,
                providerConfigKey: provider_config_key,
                syncNames: syncNames as string[],
                command: full_resync ? SyncCommand.RUN_FULL : SyncCommand.RUN,
                logContextGetter,
                connectionId: connection_id!
            });

            if (!success) {
                errorManager.errResFromNangoErr(res, error);
                return;
            }

            res.sendStatus(200);
        } catch (e) {
            next(e);
        }
    }

    public async actionOrModel(req: Request, res: Response<any, Required<RequestLocals>>, next: NextFunction) {
        try {
            const environmentId = res.locals['environment'].id;
            const providerConfigKey = req.get('Provider-Config-Key') as string;
            const connectionId = req.get('Connection-Id') as string;
            const path = '/' + req.params['0'];
            if (!connectionId) {
                res.status(400).send({ error: 'Missing connection id' });

                return;
            }

            if (!providerConfigKey) {
                res.status(400).send({ error: 'Missing provider config key' });

                return;
            }
            const { success, error, response: connection } = await connectionService.getConnection(connectionId, providerConfigKey, environmentId);

            if (!success) {
                errorManager.errResFromNangoErr(res, error);
                return;
            }

            const { action, model } = await getActionOrModelByEndpoint(connection as NangoConnection, req.method as HTTP_VERB, path);
            if (action) {
                const input = req.body || req.params[1];
                req.body = {};
                req.body['action_name'] = action;
                req.body['input'] = input;
                await this.triggerAction(req, res, next);
            } else if (model) {
                req.query['model'] = model;
                await this.getAllRecords(req, res, next);
            } else {
                res.status(404).send({ message: `Unknown endpoint '${req.method} ${path}'` });
            }
        } catch (e) {
            next(e);
        }
    }

    public async triggerAction(req: Request, res: Response<any, Required<RequestLocals>>, next: NextFunction) {
        const active = tracer.scope().active();
        const span = tracer.startSpan('server.sync.triggerAction', {
            childOf: active as Span
        });

        const { input, action_name } = req.body;
        const accountId = res.locals['account'].id;
        const environmentId = res.locals['environment'].id;
        const connectionId = req.get('Connection-Id');
        const providerConfigKey = req.get('Provider-Config-Key');
        let logCtx: LogContext | undefined;
        try {
            if (!action_name || typeof action_name !== 'string') {
                res.status(400).send({ error: 'Missing action name' });

                span.finish();
                return;
            }

            if (!connectionId) {
                res.status(400).send({ error: 'Missing connection id' });

                span.finish();
                return;
            }

            if (!providerConfigKey) {
                res.status(400).send({ error: 'Missing provider config key' });

                span.finish();
                return;
            }

            const { success, error, response: connection } = await connectionService.getConnection(connectionId, providerConfigKey, environmentId);

            if (!success || !connection) {
                errorManager.errResFromNangoErr(res, error);

                span.finish();
                return;
            }

            const provider = await configService.getProviderConfig(providerConfigKey, environmentId);

            const log = {
                level: 'info' as LogLevel,
                success: false,
                action: LogActionEnum.ACTION,
                start: Date.now(),
                end: Date.now(),
                timestamp: Date.now(),
                connection_id: connection.connection_id,
                provider: provider!.provider,
                provider_config_key: connection.provider_config_key,
                environment_id: environmentId,
                operation_name: action_name
            };

            span.setTag('nango.actionName', action_name)
                .setTag('nango.connectionId', connectionId)
                .setTag('nango.environmentId', environmentId)
                .setTag('nango.providerConfigKey', providerConfigKey);

            const activityLogId = await createActivityLog(log);
            if (!activityLogId) {
                throw new NangoError('failed_to_create_activity_log');
            }

            logCtx = await logContextGetter.create(
                { id: String(activityLogId), operation: { type: 'action' }, message: 'Start action' },
                { account: { id: accountId }, environment: { id: environmentId }, config: { id: provider!.id! }, connection: { id: connection.id! } }
            );

            const syncClient = await SyncClient.getInstance();

            if (!syncClient) {
                throw new NangoError('failed_to_get_sync_client');
            }

            const actionResponse = await syncClient.triggerAction({
                connection,
                actionName: action_name,
                input,
                activityLogId,
                environment_id: environmentId,
                logCtx
            });

            if (isOk(actionResponse)) {
                span.finish();
                await logCtx.success();
                res.send(actionResponse.res);

                return;
            } else {
                span.setTag('nango.error', actionResponse.err);
                errorManager.errResFromNangoErr(res, actionResponse.err);
                await logCtx.error('Failed to trigger action', { err: actionResponse.err });
                await logCtx.failed();
                span.finish();

                return;
            }
        } catch (err) {
            span.setTag('nango.error', err);
            span.finish();
            if (logCtx) {
                await logCtx.error('Failed to trigger action', { error: err });
                await logCtx.failed();
            }

            next(err);
        }
    }

    public async getSyncProvider(req: Request, res: Response<any, Required<RequestLocals>>, next: NextFunction) {
        try {
            const environmentId = res.locals['environment'].id;
            const { syncName } = req.query;

            if (!syncName) {
                res.status(400).send({ message: 'Missing sync name!' });

                return;
            }

            const providerConfigKey = await getProviderConfigBySyncAndAccount(syncName as string, environmentId);

            res.send(providerConfigKey);
        } catch (e) {
            next(e);
        }
    }

    public async pause(req: Request, res: Response<any, Required<RequestLocals>>, next: NextFunction) {
        try {
            const { syncs: syncNames, provider_config_key, connection_id } = req.body;

            if (!provider_config_key) {
                res.status(400).send({ message: 'Missing provider config key' });

                return;
            }

            if (typeof syncNames === 'string') {
                res.status(400).send({ message: 'Syncs must be an array' });

                return;
            }

            if (!syncNames) {
                res.status(400).send({ message: 'Missing sync names' });

                return;
            }

            const environmentId = res.locals['environment'].id;

            await syncOrchestrator.runSyncCommand({
                recordsService,
                environmentId,
                providerConfigKey: provider_config_key as string,
                syncNames: syncNames as string[],
                command: SyncCommand.PAUSE,
                logContextGetter,
                connectionId: connection_id
            });

            res.sendStatus(200);
        } catch (e) {
            next(e);
        }
    }

    public async start(req: Request, res: Response<any, Required<RequestLocals>>, next: NextFunction) {
        try {
            const { syncs: syncNames, provider_config_key, connection_id } = req.body;

            if (!provider_config_key) {
                res.status(400).send({ message: 'Missing provider config key' });

                return;
            }

            if (typeof syncNames === 'string') {
                res.status(400).send({ message: 'Syncs must be an array' });

                return;
            }

            if (!syncNames) {
                res.status(400).send({ message: 'Missing sync names' });

                return;
            }

            const environmentId = res.locals['environment'].id;

            await syncOrchestrator.runSyncCommand({
                recordsService,
                environmentId,
                providerConfigKey: provider_config_key as string,
                syncNames: syncNames as string[],
                command: SyncCommand.UNPAUSE,
                logContextGetter,
                connectionId: connection_id
            });

            res.sendStatus(200);
        } catch (e) {
            next(e);
        }
    }

    public async getSyncStatus(req: Request, res: Response<any, Required<RequestLocals>>, next: NextFunction) {
        try {
            const { syncs: passedSyncNames, provider_config_key, connection_id } = req.query;

            let syncNames = passedSyncNames;

            if (!provider_config_key) {
                res.status(400).send({ message: 'Missing provider config key' });

                return;
            }

            if (!syncNames) {
                res.status(400).send({ message: 'Sync names must be passed in' });

                return;
            }

            const environmentId = res.locals['environment'].id;

            let connection: Connection | null = null;

            if (connection_id) {
                const connectionResult = await connectionService.getConnection(connection_id as string, provider_config_key as string, environmentId);
                const { success: connectionSuccess, error: connectionError } = connectionResult;
                if (!connectionSuccess || !connectionResult.response) {
                    errorManager.errResFromNangoErr(res, connectionError);
                    return;
                }

                connection = connectionResult.response;
            }

            if (syncNames === '*') {
                if (connection && connection.id) {
                    syncNames = await getSyncNamesByConnectionId(connection.id);
                } else {
                    const syncs = await getSyncsByProviderConfigKey(environmentId, provider_config_key as string);
                    syncNames = syncs.map((sync) => sync.name);
                }
            } else {
                syncNames = (syncNames as string).split(',');
            }

            const {
                success,
                error,
                response: syncsWithStatus
            } = await syncOrchestrator.getSyncStatus(environmentId, provider_config_key as string, syncNames, connection_id as string, false, connection);

            if (!success || !syncsWithStatus) {
                errorManager.errResFromNangoErr(res, error);
                return;
            }

            res.send({ syncs: syncsWithStatus });
        } catch (e) {
            next(e);
        }
    }

    public async syncCommand(req: Request, res: Response<any, Required<RequestLocals>>, next: NextFunction) {
        let logCtx: LogContext | undefined;

        try {
            const { environment } = res.locals;

            const { schedule_id, command, nango_connection_id, sync_id, sync_name, provider } = req.body;
            const connection = await connectionService.getConnectionById(nango_connection_id);

            const action = CommandToActivityLog[command as SyncCommand];

            const log = {
                level: 'info' as LogLevel,
                success: false,
                action,
                start: Date.now(),
                end: Date.now(),
                timestamp: Date.now(),
                connection_id: connection?.connection_id as string,
                provider,
                provider_config_key: connection?.provider_config_key as string,
                environment_id: environment.id,
                operation_name: sync_name
            };
            const activityLogId = await createActivityLog(log);
            logCtx = await logContextGetter.create(
                {
                    id: String(activityLogId),
                    operation: { type: 'sync', action: syncCommandToOperation[command as SyncCommand] },
                    message: `Trigger ${command}`
                },
                { account: { id: environment.account_id }, environment: { id: environment.id, name: environment.name }, connection: { id: connection!.id! } }
            );

            if (!(await verifyOwnership(nango_connection_id, environment.id, sync_id))) {
                await createActivityLogMessage({
                    level: 'error',
                    activity_log_id: activityLogId!,
                    environment_id: environment.id,
                    timestamp: Date.now(),
                    content: `Unauthorized access to run the command: "${action}" for sync: ${sync_id}`
                });
                await logCtx.error('Unauthorized access to run the command');
                await logCtx.failed();

                res.sendStatus(401);
                return;
            }

            const syncClient = await SyncClient.getInstance();

            if (!syncClient) {
                const error = new NangoError('failed_to_get_sync_client');
                errorManager.errResFromNangoErr(res, error);
                await logCtx.failed();

                return;
            }

            const result = await syncClient.runSyncCommand({
                scheduleId: schedule_id,
                syncId: sync_id,
                command,
                activityLogId: activityLogId as number,
                environmentId: environment.id,
                providerConfigKey: connection?.provider_config_key as string,
                connectionId: connection?.connection_id as string,
                syncName: sync_name,
                nangoConnectionId: connection?.id,
                logCtx,
                recordsService
            });

            if (isErr(result)) {
                errorManager.handleGenericError(result.err, req, res, tracer);
                await logCtx.failed();
                return;
            }

            if (command !== SyncCommand.RUN) {
                await updateScheduleStatus(schedule_id, command, activityLogId as number, environment.id, logCtx);
            }

            await createActivityLogMessageAndEnd({
                level: 'info',
                environment_id: environment.id,
                activity_log_id: activityLogId as number,
                timestamp: Date.now(),
                content: `Sync was updated with command: "${action}" for sync: ${sync_id}`
            });
            await updateSuccessActivityLog(activityLogId as number, true);
            await logCtx.info('Sync command run successfully', { action, syncId: sync_id });
            await logCtx.success();

            let event = AnalyticsTypes.SYNC_RUN;

            switch (command) {
                case SyncCommand.PAUSE:
                    event = AnalyticsTypes.SYNC_PAUSE;
                    break;
                case SyncCommand.UNPAUSE:
                    event = AnalyticsTypes.SYNC_UNPAUSE;
                    break;
                case SyncCommand.RUN:
                    event = AnalyticsTypes.SYNC_RUN;
                    break;
                case SyncCommand.CANCEL:
                    event = AnalyticsTypes.SYNC_CANCEL;
                    break;
            }

            void analytics.trackByEnvironmentId(event, environment.id, {
                sync_id,
                sync_name,
                provider,
                provider_config_key: connection?.provider_config_key as string,
                connection_id: connection?.connection_id as string,
                schedule_id
            });

            res.sendStatus(200);
        } catch (err) {
            if (logCtx) {
                await logCtx.error('Failed to sync command', { error: err });
                await logCtx.failed();
            }
            next(err);
        }
    }

    public async getFlowAttributes(req: Request, res: Response<any, Required<RequestLocals>>, next: NextFunction) {
        try {
            const { sync_name, provider_config_key } = req.query;

            if (!provider_config_key) {
                res.status(400).send({ message: 'Missing provider config key' });

                return;
            }

            if (!sync_name) {
                res.status(400).send({ message: 'Missing sync name' });

                return;
            }

            const attributes = await getAttributes(provider_config_key as string, sync_name as string);

            res.status(200).send(attributes);
        } catch (e) {
            next(e);
        }
    }

    public async updateFrequency(req: Request, res: Response<any, Required<RequestLocals>>, next: NextFunction) {
        try {
            const { environment } = res.locals;
            const syncConfigId = req.params['syncId'];
            const { frequency } = req.body;

            if (!syncConfigId) {
                res.status(400).send({ message: 'Missing sync config id' });

                return;
            }

            if (!frequency) {
                res.status(400).send({ message: 'Missing frequency' });

                return;
            }

            const syncs = await getSyncsBySyncConfigId(environment.id, Number(syncConfigId));
            const setFrequency = `every ${frequency}`;
            for (const sync of syncs) {
                const { success: updateScheduleSuccess, error: updateScheduleError } = await updateSyncScheduleFrequency(
                    sync.id,
                    setFrequency,
                    sync.name,
                    environment.id
                );

                if (!updateScheduleSuccess) {
                    errorManager.errResFromNangoErr(res, updateScheduleError);
                    return;
                }
            }
            await updateFrequency(Number(syncConfigId), setFrequency);

            res.sendStatus(200);
        } catch (e) {
            next(e);
        }
    }

    public async deleteSync(req: Request, res: Response<any, Required<RequestLocals>>, next: NextFunction) {
        try {
            const syncId = req.params['syncId'];
            const { connection_id, provider_config_key } = req.query;

            if (!provider_config_key) {
                res.status(400).send({ message: 'Missing provider config key' });

                return;
            }

            if (!syncId) {
                res.status(400).send({ message: 'Missing sync id' });

                return;
            }

            if (!connection_id) {
                res.status(400).send({ message: 'Missing connection id' });

                return;
            }

            const environmentId = res.locals['environment'].id;

            const isValid = await isSyncValid(connection_id as string, provider_config_key as string, environmentId, syncId);

            if (!isValid) {
                res.status(400).send({ message: 'Invalid sync id' });

                return;
            }

            await syncOrchestrator.softDeleteSync(syncId, environmentId);

            res.sendStatus(204);
        } catch (e) {
            next(e);
        }
    }

    /**
     * PUT /sync/update-connection-frequency
     *
     * Allow users to change the default frequency value of a sync without losing the value.
     * The system will store the value inside `_nango_syncs.frequency` and update the relevant schedules.
     */
    public async updateFrequencyForConnection(req: Request, res: Response<any, Required<RequestLocals>>, next: NextFunction) {
        try {
            const { sync_name, provider_config_key, connection_id, frequency } = req.body;

            if (!provider_config_key || typeof provider_config_key !== 'string') {
                res.status(400).send({ message: 'provider_config_key must be a string' });
                return;
            }
            if (!sync_name || typeof sync_name !== 'string') {
                res.status(400).send({ message: 'sync_name must be a string' });
                return;
            }
            if (!connection_id || typeof connection_id !== 'string') {
                res.status(400).send({ message: 'connection_id must be a string' });
                return;
            }
            if (typeof frequency !== 'string' && frequency !== null) {
                res.status(400).send({ message: 'frequency must be a string or null' });
                return;
            }

            let newFrequency: string | undefined;
            if (frequency) {
                const { error, response } = getInterval(frequency, new Date());
                if (error || !response) {
                    res.status(400).send({ message: 'frequency must have a valid format (https://github.com/vercel/ms)' });
                    return;
                }
                newFrequency = response.interval;
            }

            const envId = res.locals['environment'].id;

            const getConnection = await connectionService.getConnection(connection_id, provider_config_key, envId);
            if (!getConnection.response || getConnection.error) {
                res.status(400).send({ message: 'Invalid connection_id' });
                return;
            }
            const connection = getConnection.response;

            const syncs = await findSyncByConnections([Number(connection.id)], sync_name);
            if (syncs.length <= 0) {
                res.status(400).send({ message: 'Invalid sync_name' });
                return;
            }
            const syncId = syncs[0]!.id;

            // When "frequency === null" we revert the value stored in the sync config
            if (!newFrequency) {
                const providerId = await configService.getIdByProviderConfigKey(envId, provider_config_key);
                const syncConfigs = await getSyncAndActionConfigsBySyncNameAndConfigId(envId, providerId!, sync_name);
                if (syncConfigs.length <= 0) {
                    res.status(400).send({ message: 'Invalid sync_name' });
                    return;
                }
                newFrequency = syncConfigs[0]!.runs;
            }

            await setFrequency(syncId, frequency);

            const { success, error } = await updateSyncScheduleFrequency(syncId, newFrequency, sync_name, connection.environment_id);
            if (!success) {
                errorManager.errResFromNangoErr(res, error);
                return;
            }

            res.status(200).send({ frequency: newFrequency });
        } catch (e) {
            next(e);
        }
    }
}

export default new SyncController();
