import { each, isNumber, uniqueId, size, indexOf, omit, defaultsDeep, pickBy } from 'lodash';
import _debug from 'debug';
const debug = _debug('worker:stage');

import { StageExecutionProvider } from '../../providers/stageExecution.provider';
import { exitRequest } from 'node_common/dist/utils/errors';

import { StageStatusEnum } from '../../types/stageStatus.type';
import { ModuleConfigInterface } from '../../interfaces/moduleConfig.interface';
import { StageConfigInterface } from '../../interfaces/stageConfig.interface';
import { StageExecutionInterface } from '../../interfaces/stageExecution.interface';

import { BodyInterface } from '../../interfaces/body.interface';
import { ResultInterface } from '../../interfaces/result.interface';
import { ModuleExecutionInterface } from '../../interfaces/moduleExecution.interface';
import { ProjectInterface } from '../../interfaces/project.interface';
import { ERROR } from '../../types/error.type';
import { WorkerError } from './error';
import { getDateForTimezone } from 'node_common/dist/utils';

export class StageWorker {
    static getSolutions;
    public fakeResult = false;
    protected readonly worflowEventName = 'm0/workflow';
    protected defaultConfig: any = {};

    protected uniqueId: string;
    protected body: BodyInterface;

    protected transactionUid: string;
    protected moduleUid: string;
    protected stageUid: string;
    protected stageName: string;

    protected moduleExecution: ModuleExecutionInterface;
    protected moduleConfig: ModuleConfigInterface;
    protected stageConfig: StageConfigInterface;
    protected project: ProjectInterface;

    protected stageExecution: StageExecutionInterface;
    protected stageExecutionMocked = false;

    protected rootDir = '';
    protected moduleDir = '';
    protected stageDir = '';

    private set({ transactionUid, moduleUid, stageUid, stageName, moduleConfig, stageConfig, body }) {
        this.transactionUid = transactionUid;
        this.moduleUid = moduleUid;
        this.stageUid = stageUid;
        this.stageName = stageName;
        this.moduleConfig = moduleConfig;
        this.stageConfig = stageConfig;
        this.body = body;
        this.project = this.moduleConfig.project;

        this.setDirs();
    }

    protected getProjectUid() {
        return this.moduleConfig.projectUid || this.project.uid;
    }

    private setDirs() {
        this.rootDir = [this.getProjectUid(), this.transactionUid].join('/');
        this.moduleDir = [this.rootDir, this.moduleConfig.moduleUid].join('/');
        this.stageDir = [this.rootDir, this.stageConfig.stageUid].join('/');
    }

    constructor(options) {
        this.set(options);
    }

    protected defaultOptions = {
        _attempts: 1,
        _triggerNextStage: 1,
        index: -1,
    };

    protected prepareOptions(): any {
        const options = this.body.options || {};

        each(this.defaultOptions, (value, key) => {
            !(key in options) && (options[key] = value);
        });

        return options;
    }

    private async checkExecution() {
        if (!this.stageExecution) exitRequest(ERROR.NO_STAGE_EXEC_DATA);
    }

    private async __debug(...args) {
        if (!this.fakeResult) {
            debug(...args);
        }
    }

    public async initialize(uniqueId: string): Promise<any> {
        this.__debug('-------------------------\ninitialize');
        this.__debug('set unique id', uniqueId);
        this.setUniqueId(uniqueId);
        this.__debug('find module+stage execution');
        this.stageExecution = await this.findLastStageExecution();
        this.moduleExecution = this.stageExecution.moduleExecution;

        if (!this.fakeResult) {
            const result = await this._execute();

            debug('check result');
            if (result !== null) await this.result(result);

            debug('on destroy');
            await this._onDestroy();
            debug('builder done\n-------------------------');
        } else {
            await this.result(this.statusDone());
        }
        return { done: true };
    }

    private setUniqueId(_uniqueId = '') {
        !_uniqueId && (_uniqueId = [uniqueId('worker:'), new Date().toISOString()].join(':'));
        this.uniqueId = _uniqueId;
    }

    private async _execute(): Promise<ResultInterface | null> {
        await this.checkExecution();
        let result;

        try {
            debug('on initialize');
            await this._onInitialize();

            debug('execute');
            result = await this.execute();
        } catch (error) {
            this.logError(error);
            result = {
                statusUid: error.statusUid || StageStatusEnum.UNKNOWN,
                errorCode: error.code || '',
                errorMessage: error.message || '',
            };
        }

        return result;
    }

    public logError(error) {
        console.log(this.stageDir, typeof error === 'string' ? error : error.stack);
    }

    protected async execute(): Promise<ResultInterface | null> {
        console.log('stage.builder execute()', this.stageUid);
        return { statusUid: StageStatusEnum.DONE };
    }

    public async result(result: ResultInterface) {
        result.statusUid = result.statusUid || StageStatusEnum.UNKNOWN;
        await this.triggerResult(result);

        result._options?.after && (await result._options.after());
    }

    protected async findLastStageExecution() {
        if (this.body.mockStageExecution) return this.mockStageExecution();
        const stageExecution = await StageExecutionProvider.findByTransactionAndModuleAndIndex(
            this.transactionUid,
            this.stageConfig.stageUid,
            this.body.options.index,
        );

        if (
            stageExecution?.statusUid &&
            indexOf(
                [
                    // StageStatusEnum.DONE,
                    StageStatusEnum.FAILED,
                    StageStatusEnum.UNKNOWN,
                ],
                stageExecution.statusUid,
            ) === -1
        ) {
            return stageExecution;
        }
    }

    protected async triggerStage(_name, body) {
        const { events } = await StageWorker.getSolutions();
        // const name = _name.replace(/\//g, '-');
        events.sendToQueue(_name, body);
    }

    protected async triggerResult(result: ResultInterface) {
        const index = this.stageExecution.data.index;
        debug(`result:`, result, '; stage:', this.stageUid, '; index: ', index);
        if (typeof result === 'undefined' || result === null || this.stageExecutionMocked) return;

        result.statusUid = result.statusUid || StageStatusEnum.UNKNOWN;
        // avoid infinity loop when waiting multiple child process
        // but with this waiting status never is saved
        // if (result.status === StageStatusEnum.WAITING) return;

        const { events } = await StageWorker.getSolutions();
        const body = {
            transactionUid: this.transactionUid,
            stageUid: this.stageUid,
            options: {
                index,
            },
            result: {
                ...omit(result, '_options'),
                errorMessage: (result.errorMessage || '').split('\n')[0],
            },
        };

        events.sendToQueue(this.worflowEventName, body);
    }

    protected prepareConfig(_config) {
        return defaultsDeep(_config, this.defaultConfig);
    }

    protected mockStageExecution() {
        this.stageExecutionMocked = true;
        const mock = typeof this.body.mockStageExecution === 'object' ? this.body.mockStageExecution : {};
        return defaultsDeep(mock, {
            moduleExecutionId: 0,
            stageConfigId: 0,
            data: {},
            statusUid: StageStatusEnum.ASYNC,
        });
    }

    protected fowardInternalOptions() {
        return pickBy(this.stageExecution.data, (value, key) => {
            return /^_[a-zA-Z]/.test(key);
        });
    }

    protected _isConfigActivated(configHolderKey, configName, configKey = 'config') {
        const value = this[configHolderKey][configKey][configName];

        return (
            (isNumber(value) && value > 0) ||
            value === true ||
            (size(value) > 0 && !this._isConfigDeactivated(configHolderKey, configName, configKey))
        );
    }

    protected _isConfigDeactivated(configHolderKey, configName, configKey = 'config') {
        const value = this[configHolderKey][configKey][configName];
        return value === 0 || value === false;
    }

    public isStageConfigActivated(configName) {
        return this._isConfigActivated('stageConfig', configName);
    }

    public isStageConfigDeactivated(configName) {
        return this._isConfigDeactivated('stageConfig', configName);
    }

    public isModuleConfigActivated(configName) {
        return this._isConfigActivated('moduleConfig', configName);
    }

    public isModuleConfigDeactivated(configName) {
        return this._isConfigDeactivated('moduleConfig', configName);
    }

    public isProjectConfigActivated(configName) {
        return this._isConfigActivated('project', configName, '_config');
    }

    public isProjectConfigDeactivated(configName) {
        return this._isConfigDeactivated('project', configName, '_config');
    }

    async getSecret(name: string, basePath: any = null) {
        name = name.replace(/^\//, '').replace(/\/$/, '');
        const { secrets } = await StageWorker.getSolutions();

        if (this.body.options.clearSecrets || !!process.env.IS_TS_NODE) secrets.clearCache();

        const env = process.env.NODE_ENV || 'dev';
        const path = ['', env];
        basePath === null && (basePath = [this.getProjectUid()].join('/'));
        path.push(basePath);
        path.push(name);

        const secretPath = path.join('/');
        const value = await secrets.getSecretValue(secretPath);
        if (!value) throw new WorkerError(`secret value not found for ${secretPath}`, StageStatusEnum.FAILED);

        return value;
    }

    async getGlobalSecret(name: string, basePath: any = null) {
        basePath === null && (basePath = ['mx'].join('/'));
        return await this.getSecret(name, basePath);
    }

    async getModuleSecret(name: string, basePath: any = null) {
        basePath === null && (basePath = [this.getProjectUid(), this.moduleUid].join('/'));
        return await this.getSecret(name, basePath);
    }

    async getStageSecret(name: string, basePath: any = null) {
        basePath === null && (basePath = [this.getProjectUid(), this.stageUid].join('/'));
        return await this.getSecret(name, basePath);
    }

    /* date */
    getTimezoneOffset(_customTimezoneOffset = 0) {
        return +(_customTimezoneOffset || this.project?._config?.timezoneOffset || 0);
    }

    getTimezoneString(_customTimezoneOffset = 0, addMinutes = false) {
        const timezoneOffset = this.getTimezoneOffset(_customTimezoneOffset);
        const timezoneData = (timezoneOffset + '').split('');
        timezoneData[1] = timezoneData[1].padStart(2, '0');
        const timezoneString = timezoneData.join('');
        return timezoneString + (addMinutes ? ':00' : '');
    }

    getDate(date = undefined, keepLocalTime = false, _customTimezoneOffset = 0) {
        const timezoneOffset = this.getTimezoneOffset(_customTimezoneOffset);
        return getDateForTimezone(timezoneOffset, date, keepLocalTime);
    }

    /* results */
    public statusDone(options: any = {}) {
        return {
            ...options,
            statusUid: StageStatusEnum.DONE,
        };
    }

    public statusFailed(options: any = {}) {
        return {
            ...options,
            statusUid: StageStatusEnum.FAILED,
        };
    }

    public statusWaiting(options: any = {}) {
        return {
            ...options,
            statusUid: StageStatusEnum.WAITING,
        };
    }

    // getters
    public get() {
        return {
            body: this.body,
            transactionUid: this.transactionUid,
            moduleConfig: this.moduleConfig,
            stageConfig: this.stageConfig,
            stageExecution: this.stageExecution,
            project: this.project,
            rootDir: this.rootDir,
            stageDir: this.stageDir,
        };
    }

    public getBody() {
        return this.body;
    }

    public getTransactionUid() {
        return this.transactionUid;
    }

    public getModuleConfig() {
        return this.moduleConfig;
    }

    public getStageConfig() {
        return this.stageConfig;
    }

    public getStageExecution() {
        return this.stageExecution;
    }

    public getRootDir() {
        return this.rootDir;
    }

    public getStageDir() {
        return this.stageDir;
    }

    public getService(Service): any {
        return new Service(this.uniqueId);
    }

    public getIndex() {
        const index = this.stageExecution?.data?.index || this.body.options.index;
        return typeof index === 'undefined' ? -1 : index;
    }

    /* lifecycle methods */
    private async _onInitialize(): Promise<void> {
        try {
            await this.onInitialize();
        } catch (error) {
            debug('error on initialize');
            throw error;
        }
    }

    public async onInitialize(): Promise<void> {
        return;
    }

    private async _onDestroy(): Promise<void> {
        try {
            await this.onDestroy();
        } catch (error) {
            debug('error on destroy');
            this.logError(error);
        }
    }

    public async onDestroy(): Promise<void> {
        return;
    }
}
