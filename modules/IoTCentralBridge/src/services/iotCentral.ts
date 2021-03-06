import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import * as _get from 'lodash.get';
import * as ip from 'ip';
import {
    arch as osArch,
    platform as osPlatform,
    release as osRelease,
    cpus as osCpus,
    totalmem as osTotalMem,
    freemem as osFreeMem,
    loadavg as osLoadAvg
} from 'os';
import { ConfigService } from './config';
import { StorageService } from './storage';
import { Mqtt } from 'azure-iot-device-mqtt';
import {
    ModuleClient,
    Message,
    DeviceMethodRequest,
    DeviceMethodResponse
} from 'azure-iot-device';
import { healthCheckInterval, HealthState } from './health';
import { bind, defer, emptyObj, sleep } from '../utils';

export interface ISystemProperties {
    cpuModel: string;
    cpuCores: number;
    cpuUsage: number;
    totalMemory: number;
    freeMemory: number;
}

export const IoTCentralDeviceFieldIds = {
    Property: {
        Manufacturer: 'manufacturer',
        Model: 'model',
        SwVersion: 'swVersion',
        OsName: 'osName',
        ProcessorArchitecture: 'processorArchitecture',
        ProcessorManufacturer: 'processorManufacturer',
        TotalStorage: 'totalStorage',
        TotalMemory: 'totalMemory',
        GpuProcessor: 'gpuProcessor'
    }
};

interface IVideoStreamInput {
    cameraId: string;
    videoStreamUrl: string;
}

interface IDetectionSettings {
    wpDemoMode: boolean;
    wpAIModelProvider: string;
    wpCustomVisionModelUrl: string;
    wpPrimaryDetectionClass: string;
    wpSecondaryDetectionClass: string;
}

interface IVideoStreamInputSettings {
    wpVideoStreamInput1: IVideoStreamInput;
    wpVideoStreamInput2: IVideoStreamInput;
    wpVideoStreamInput3: IVideoStreamInput;
    wpVideoStreamInput4: IVideoStreamInput;
}

export enum ModuleState {
    Inactive = 'inactive',
    Active = 'active'
}

export enum PipelineState {
    Inactive = 'inactive',
    Active = 'active'
}

export enum AIModelProvider {
    DeepStream = 'DeepStream',
    CustomVision = 'CustomVision'
}

export enum RestartDeviceCommandParams {
    Timeout = 'cmpRestartDeviceTimeout'
}

export const ModuleInfoFieldIds = {
    Telemetry: {
        SystemHeartbeat: 'tlSystemHeartbeat',
        PrimaryDetectionCount: 'tlPrimaryDetectionCount',
        SecondaryDetectionCount: 'tlSecondaryDetectionCount',
        Inference: 'tlInference',
        FreeMemory: 'tlFreeMemory',
        InferenceRate: 'tlInferenceRate',
        PrimaryDetectionClass: 'tlPrimaryDetectionClass',
        SecondaryDetectionClass: 'tlSecondaryDetectionClass'
    },
    State: {
        ModuleState: 'stModuleState',
        PipelineState: 'stPipelineState'
    },
    Event: {
        VideoStreamProcessingStarted: 'evVideoStreamProcessingStarted',
        VideoStreamProcessingStopped: 'evVideoStreamProcessingStopped',
        ChangeVideoModel: 'evChangeVideoModel',
        DeviceRestart: 'evDeviceRestart'
    },
    Setting: {
        DemoMode: 'wpDemoMode',
        AIModelProvider: 'wpAIModelProvider',
        CustomVisionModelUrl: 'wpCustomVisionModelUrl',
        PrimaryDetectionClass: 'wpPrimaryDetectionClass',
        SecondaryDetectionClass: 'wpSecondaryDetectionClass',
        VideoStreamInput1: 'wpVideoStreamInput1',
        VideoStreamInput2: 'wpVideoStreamInput2',
        VideoStreamInput3: 'wpVideoStreamInput3',
        VideoStreamInput4: 'wpVideoStreamInput4'
    },
    Property: {
        RtspVideoUrl: 'rpRtspVideoUrl',
        VideoTaggingClientUrl: 'rpVideoTaggingClientUrl'
    },
    Command: {
        RestartDeepStream: 'cmRestartDeepStream',
        RestartDevice: 'cmRestartDevice'
    }
};

const defaultInferenceThrottle: number = 500;

@service('iotCentral')
export class IoTCentralService {
    @inject('$server')
    private server: Server;

    @inject('config')
    private config: ConfigService;

    @inject('storage')
    private storage: StorageService;

    private serviceInitializing: boolean = true;
    private healthState = HealthState.Good;
    private measurementsSentInternal: number = 0;
    private deferredStart = defer();
    private iotcDeviceIdInternal: string = '';
    private iotcModuleIdInternal: string = '';
    private iotcClient: any = null;
    private iotcDeviceTwin: any = null;
    private iotcClientConnected: boolean = false;
    private iotcTelemetryThrottleTimer: number = Date.now();
    private inferenceThrottle: number = defaultInferenceThrottle;
    private inferenceRateCount: number = 0;
    private pipelineState: boolean = false;
    private detectionSettingsInternal: IDetectionSettings = {
        wpDemoMode: true,
        wpAIModelProvider: 'CustomVision',
        wpCustomVisionModelUrl: '',
        wpPrimaryDetectionClass: 'person',
        wpSecondaryDetectionClass: 'car'
    };
    private videoStreamInputSettingsInternal: IVideoStreamInputSettings = {
        wpVideoStreamInput1: {
            cameraId: '',
            videoStreamUrl: ''
        },
        wpVideoStreamInput2: {
            cameraId: '',
            videoStreamUrl: ''
        },
        wpVideoStreamInput3: {
            cameraId: '',
            videoStreamUrl: ''
        },
        wpVideoStreamInput4: {
            cameraId: '',
            videoStreamUrl: ''
        }
    };
    private moduleIpAddress: string = '127.0.0.1';

    public get measurementsSent() {
        return this.measurementsSentInternal;
    }

    public get iotcDeviceId() {
        return this.iotcDeviceIdInternal;
    }

    public get iotcModuleId() {
        return this.iotcModuleIdInternal;
    }

    public get detectionSettings() {
        return this.detectionSettingsInternal;
    }

    public get videoStreamInputSettings() {
        return this.videoStreamInputSettingsInternal;
    }

    public async init(): Promise<void> {
        this.server.log(['IoTCentral', 'info'], 'initialize');

        this.server.method({ name: 'iotCentral.connectToIoTCentral', method: this.connectToIoTCentral });

        this.measurementsSentInternal = 0;
        this.iotcDeviceIdInternal = this.config.get('IOTEDGE_DEVICEID') || '';
        this.iotcModuleIdInternal = this.config.get('IOTEDGE_MODULEID') || '';

        this.inferenceThrottle = this.config.get('inferenceThrottle') || defaultInferenceThrottle;
        this.moduleIpAddress = ip.address() || '127.0.0.1';
    }

    public async getHealth(): Promise<number> {
        let healthState = this.healthState;

        await this.sendMeasurement({
            [ModuleInfoFieldIds.Telemetry.InferenceRate]: this.inferenceRateCount / (healthCheckInterval || 1)
        });
        this.inferenceRateCount = 0;

        try {
            if (healthState === HealthState.Good) {
                const systemProperties = await this.getSystemProperties();
                const freeMemory = _get(systemProperties, 'freeMemory') || 0;

                // TODO:
                // Find the right threshold for this metric
                if (freeMemory === 0) {
                    healthState = HealthState.Critical;
                }

                await this.sendMeasurement({
                    [ModuleInfoFieldIds.Telemetry.FreeMemory]: freeMemory,
                    [ModuleInfoFieldIds.Telemetry.SystemHeartbeat]: healthState
                });
            }

            this.healthState = healthState;
        }
        catch (ex) {
            this.server.log(['IoTCentralService', 'error'], `Error calling systemProperties: ${ex.message}`);
            healthState = HealthState.Critical;
        }

        return this.healthState;
    }

    @bind
    public async connectToIoTCentral(): Promise<void> {
        let result = true;

        try {
            this.server.log(['IoTCentralService', 'info'], `Starting client connection sequence...`);

            result = await this.connectIotcClient();

            if (result === true) {
                await this.deferredStart.promise;
            }

            this.server.log(['IoTCentralService', 'info'], `Finished client connection sequence...`);
        }
        catch (ex) {
            result = false;

            this.server.log(['IoTCentralService', 'error'], `Exception during IoT Central device provsioning: ${ex.message}`);
        }

        this.healthState = result === true ? HealthState.Good : HealthState.Critical;
        this.serviceInitializing = false;
    }

    public async connectIotcClient(): Promise<boolean> {
        let result = true;
        let connectionStatus = `IoT Central successfully connected device: ${this.iotcDeviceIdInternal}`;

        if (this.iotcClient) {
            await this.iotcClient.close();
            this.iotcClient = null;
        }

        try {
            this.server.log(['IoTCentralService', 'info'], `IOTEDGE_WORKLOADURI: ${this.config.get('IOTEDGE_WORKLOADURI')}`);
            this.server.log(['IoTCentralService', 'info'], `IOTEDGE_DEVICEID: ${this.config.get('IOTEDGE_DEVICEID')}`);
            this.server.log(['IoTCentralService', 'info'], `IOTEDGE_MODULEID: ${this.config.get('IOTEDGE_MODULEID')}`);
            this.server.log(['IoTCentralService', 'info'], `IOTEDGE_MODULEGENERATIONID: ${this.config.get('IOTEDGE_MODULEGENERATIONID')}`);
            this.server.log(['IoTCentralService', 'info'], `IOTEDGE_IOTHUBHOSTNAME: ${this.config.get('IOTEDGE_IOTHUBHOSTNAME')}`);
            this.server.log(['IoTCentralService', 'info'], `IOTEDGE_AUTHSCHEME: ${this.config.get('IOTEDGE_AUTHSCHEME')}`);

            // TODO:
            // We need to hang out here for a bit of time to avoid a race condition where the edgeHub module is not
            // yet completely initialized. In the Edge runtime release 1.0.10-rc1 there is a new "priority" property
            // that can be used for modules that need to start up in a certain order.
            await sleep(15 * 1000);

            // tslint:disable-next-line:prefer-conditional-expression
            if (_get(process.env, 'LOCAL_DEBUG') === '1') {
                this.iotcClient = ModuleClient.fromConnectionString(this.config.get('iotCentralHubConnectionString') || '', Mqtt);
            }
            else {
                this.iotcClient = await ModuleClient.fromEnvironment(Mqtt);
            }
        }
        catch (ex) {
            this.server.log(['IoTCentralService', 'error'], `Failed to instantiate client interface from configuraiton: ${ex.message}`);
        }

        if (!this.iotcClient) {
            result = false;
        }

        if (result === true) {
            try {
                await this.iotcClient.open();

                this.server.log(['IoTCentralService', 'info'], `Client is connected`);

                this.iotcClient.on('inputMessage', this.onHandleDownstreamMessages);
                this.iotcClient.on('error', this.onIotcClientError);
                this.iotcClient.onMethod(ModuleInfoFieldIds.Command.RestartDeepStream, this.iotcClientRestartDeepStream);
                this.iotcClient.onMethod(ModuleInfoFieldIds.Command.RestartDevice, this.iotcClientRestartDevice);

                this.iotcDeviceTwin = await this.iotcClient.getTwin();

                this.iotcDeviceTwin.on('properties.desired', this.onHandleModuleProperties);

                this.iotcClientConnected = true;

                const systemProperties = await this.getSystemProperties();
                const moduleProperties = await this.getModuleProperties();

                const deviceProperties = {
                    ...moduleProperties,
                    [IoTCentralDeviceFieldIds.Property.OsName]: osPlatform() || '',
                    [IoTCentralDeviceFieldIds.Property.SwVersion]: osRelease() || '',
                    [IoTCentralDeviceFieldIds.Property.ProcessorArchitecture]: osArch() || '',
                    [IoTCentralDeviceFieldIds.Property.ProcessorManufacturer]: 'NVIDIA',
                    [IoTCentralDeviceFieldIds.Property.TotalMemory]: systemProperties.totalMemory,
                    [ModuleInfoFieldIds.Property.RtspVideoUrl]: `rtsp://${this.moduleIpAddress}:8554/ds-test`,
                    [ModuleInfoFieldIds.Property.VideoTaggingClientUrl]: `http://${this.moduleIpAddress}:3000`
                };
                this.server.log(['IoTCentralService', 'info'], `Updating device properties: ${JSON.stringify(deviceProperties, null, 4)}`);

                await this.updateDeviceProperties(deviceProperties);
            }
            catch (ex) {
                connectionStatus = `IoT Central connection error: ${ex.message}`;
                this.server.log(['IoTCentralService', 'error'], connectionStatus);

                result = false;
            }
        }

        return result;
    }

    public async sendInferenceData(inferenceTelemetryData: any) {
        if (!inferenceTelemetryData || !this.iotcClientConnected) {
            return;
        }

        try {
            await this.sendMeasurement(inferenceTelemetryData);
        }
        catch (ex) {
            this.server.log(['IoTCentralService', 'error'], `sendInferenceData: ${ex.message}`);
        }
    }

    @bind
    public async sendMeasurement(data: any): Promise<void> {
        if (!data || !this.iotcClientConnected) {
            return;
        }

        try {
            const iotcMessage = new Message(JSON.stringify(data));

            iotcMessage.contentEncoding = 'utf-8';
            iotcMessage.contentType = 'application/json';

            await this.iotcClient.sendEvent(iotcMessage);

            if (_get(process.env, 'DEBUG_TELEMETRY') === '1') {
                this.server.log(['IoTCentralService', 'info'], `sendEvent: ${JSON.stringify(data, null, 4)}`);
            }

            for (const key in data) {
                if (!data.hasOwnProperty(key)) {
                    continue;
                }

                this.measurementsSentInternal++;
            }
        }
        catch (ex) {
            this.server.log(['IoTCentralService', 'error'], `sendMeasurement: ${ex.message}`);
        }
    }

    public async updateDeviceProperties(properties: any): Promise<void> {
        if (!properties || !this.iotcClientConnected) {
            return;
        }

        try {
            await new Promise((resolve, reject) => {
                this.iotcDeviceTwin.properties.reported.update(properties, (error) => {
                    if (error) {
                        return reject(error);
                    }

                    return resolve();
                });
            });

            this.server.log(['IoTCentralService', 'info'], `Module live properties updated: ${JSON.stringify(properties, null, 4)}`);
        }
        catch (ex) {
            this.server.log(['IoTCentralService', 'error'], `Error while updating client properties: ${ex.message}`);
        }
    }

    public async getSystemProperties(): Promise<ISystemProperties> {
        const cpus = osCpus();
        const cpuUsageSamples = osLoadAvg();

        return {
            cpuModel: Array.isArray(cpus) ? cpus[0].model : 'NVIDIA',
            cpuCores: Array.isArray(cpus) ? cpus.length : 0,
            cpuUsage: cpuUsageSamples[0],
            totalMemory: osTotalMem() / 1024,
            freeMemory: osFreeMem() / 1024
        };
    }

    public async setPipelineState(pipelineState: PipelineState) {
        const newPipelineState = pipelineState === PipelineState.Active ? true : false;

        if (newPipelineState !== this.pipelineState) {
            await this.sendMeasurement({
                [ModuleInfoFieldIds.State.PipelineState]: pipelineState
            });
        }

        this.pipelineState = newPipelineState;
    }

    private async getModuleProperties(): Promise<any> {
        let result = {};

        try {
            result = await this.storage.get('state', 'iotCentral.properties');
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Error reading module properties: ${ex.message}`);
        }

        return result;
    }

    @bind
    private async onHandleDownstreamMessages(inputName, message) {
        // this.server.log(['IoTCentralService', 'info'], `Received downstream message: ${JSON.stringify(message, null, 4)}`);

        await this.setPipelineState(PipelineState.Active);

        this.inferenceRateCount++;

        try {
            await this.iotcClient.complete(message);

            if (inputName === 'dsmessages') {
                const messageData = message.getBytes().toString('utf8');

                await this.processDeepStreamInference(messageData);
            }
            else {
                this.server.log(['IoTCentralService', 'warning'], `Warning: received routed message for unknown input: ${inputName}`);
            }
        }
        catch (ex) {
            this.server.log(['IoTCentralService', 'error'], `Error while handling downstream message: ${ex.message}`);
        }
    }

    @bind
    private async onHandleModuleProperties(desiredChangedSettings: any) {
        try {
            this.server.log(['IoTCentralService', 'info'], `desiredPropsDelta:\n${JSON.stringify(desiredChangedSettings, null, 4)}`);

            const patchedProperties = {};
            let needRestart = false;

            for (const setting in desiredChangedSettings) {
                if (!desiredChangedSettings.hasOwnProperty(setting)) {
                    continue;
                }

                if (setting === '$version') {
                    continue;
                }

                let changedSettingResult;

                switch (setting) {
                    case ModuleInfoFieldIds.Setting.DemoMode:
                    case ModuleInfoFieldIds.Setting.AIModelProvider:
                    case ModuleInfoFieldIds.Setting.CustomVisionModelUrl:
                        changedSettingResult = await this.moduleSettingChange(setting, _get(desiredChangedSettings, `${setting}`));
                        needRestart = true;
                        break;

                    case ModuleInfoFieldIds.Setting.PrimaryDetectionClass:
                    case ModuleInfoFieldIds.Setting.SecondaryDetectionClass:
                        changedSettingResult = await this.moduleSettingChange(setting, _get(desiredChangedSettings, `${setting}`));
                        break;

                    case ModuleInfoFieldIds.Setting.VideoStreamInput1:
                    case ModuleInfoFieldIds.Setting.VideoStreamInput2:
                    case ModuleInfoFieldIds.Setting.VideoStreamInput3:
                    case ModuleInfoFieldIds.Setting.VideoStreamInput4:
                        changedSettingResult = await this.moduleSettingChange(setting, _get(desiredChangedSettings, `${setting}`));
                        needRestart = true;
                        break;

                    default:
                        this.server.log(['IoTCentralService', 'error'], `Received desired property change for unknown setting '${setting}'`);
                        break;
                }

                if (_get(changedSettingResult, 'status') === true) {
                    patchedProperties[setting] = changedSettingResult.value;
                }
            }

            if (!this.serviceInitializing && !emptyObj(patchedProperties)) {
                await this.updateDeviceProperties(patchedProperties);

                if (needRestart) {
                    await (this.server.methods.module as any).updateDSConfiguration();
                    await (this.server.methods.device as any).restartDockerImage();
                }
            }
        }
        catch (ex) {
            this.server.log(['IoTCentralService', 'error'], `Exception while handling desired properties: ${ex.message}`);
        }

        this.deferredStart.resolve();
    }

    private async moduleSettingChange(setting: string, value: any): Promise<any> {
        this.server.log(['IoTCentralService', 'info'], `Handle module setting change for '${setting}': ${typeof value === 'object' && value !== null ? JSON.stringify(value, null, 4) : value}`);

        const result = {
            value: undefined,
            status: true
        };

        switch (setting) {
            case ModuleInfoFieldIds.Setting.DemoMode:
            case ModuleInfoFieldIds.Setting.AIModelProvider:
            case ModuleInfoFieldIds.Setting.CustomVisionModelUrl:
            case ModuleInfoFieldIds.Setting.PrimaryDetectionClass:
            case ModuleInfoFieldIds.Setting.SecondaryDetectionClass:
                result.value = this.detectionSettings[setting] = value || '';
                break;

            case ModuleInfoFieldIds.Setting.VideoStreamInput1:
            case ModuleInfoFieldIds.Setting.VideoStreamInput2:
            case ModuleInfoFieldIds.Setting.VideoStreamInput3:
            case ModuleInfoFieldIds.Setting.VideoStreamInput4:
                result.value = this.videoStreamInputSettings[setting] = value;
                break;

            default:
                this.server.log(['IoTCentralService', 'info'], `Unknown module setting change request '${setting}'`);
                result.status = false;
        }

        return result;
    }

    private async processDeepStreamInference(messageData: any) {
        if (!messageData || !this.iotcClientConnected || ((Date.now() - this.iotcTelemetryThrottleTimer) < this.inferenceThrottle)) {
            return;
        }
        this.iotcTelemetryThrottleTimer = Date.now();

        if (_get(process.env, 'DEBUG_ROUTING_DATA') === '1') {
            this.server.log(['IoTCentralService', 'info'], `Processing downstream data`);
            this.server.log(['IoTCentralService', 'info'], `messageData: ${messageData}`);
        }

        const messageJson = JSON.parse(messageData);
        const cameraId = _get(messageJson, 'sensorId') || 'Unknown';
        const detections = _get(messageJson, 'objects') || [];
        let primaryDetectionCount = 0;
        let secondaryDetectionCount = 0;

        for (const detection of detections) {
            const detectionFields = detection.split('|');
            const detectionClass = (detectionFields[5] || 'Unknown').trim();

            const inferenceData = {
                [ModuleInfoFieldIds.Telemetry.Inference]: {
                    cameraId,
                    trackingId: detectionFields[0] || 'Unknown',
                    className: detectionClass,
                    roi: {
                        left: Number(detectionFields[1] || 0),
                        top: Number(detectionFields[2] || 0),
                        right: Number(detectionFields[3] || 0),
                        bottom: Number(detectionFields[4] || 0)
                    }
                }
            };

            if (detectionClass.toUpperCase() === this.detectionSettings.wpPrimaryDetectionClass.toUpperCase()) {
                ++primaryDetectionCount;
                await this.sendInferenceData(inferenceData);
            }
            else if (detectionClass.toUpperCase() === this.detectionSettings.wpSecondaryDetectionClass.toUpperCase()) {
                ++secondaryDetectionCount;
                await this.sendInferenceData(inferenceData);
            }
        }

        if (primaryDetectionCount > 0) {
            await this.sendMeasurement({
                [ModuleInfoFieldIds.Telemetry.PrimaryDetectionCount]: primaryDetectionCount
            });
        }

        if (secondaryDetectionCount > 0) {
            await this.sendMeasurement({
                [ModuleInfoFieldIds.Telemetry.SecondaryDetectionCount]: secondaryDetectionCount
            });
        }
    }

    @bind
    // @ts-ignore (commandRequest)
    private async iotcClientRestartDeepStream(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log(['IoTCentralService', 'info'], `${ModuleInfoFieldIds.Command.RestartDeepStream} command received`);

        try {
            await commandResponse.send(200);
        }
        catch (ex) {
            this.server.log(['IoTCentralService', 'error'], `Error sending response for ${ModuleInfoFieldIds.Command.RestartDeepStream} command: ${ex.message}`);
        }

        await (this.server.methods.device as any).restartDeepStream();
    }

    @bind
    // @ts-ignore (commandResponse)
    private async iotcClientRestartDevice(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log(['IoTCentralService', 'info'], `${ModuleInfoFieldIds.Command.RestartDevice} command received`);

        try {
            await commandResponse.send(200);
        }
        catch (ex) {
            this.server.log(['IoTCentralService', 'error'], `Error sending response for ${ModuleInfoFieldIds.Command.RestartDevice} command: ${ex.message}`);
        }

        const timeout = _get(commandRequest, `payload.${RestartDeviceCommandParams.Timeout}`);
        await (this.server.methods.device as any).restartDevice(timeout, 'RestartDevice command received');
    }

    @bind
    private onIotcClientError(error: Error) {
        this.server.log(['IoTCentralService', 'error'], `Client connection error: ${error.message}`);
        this.healthState = HealthState.Critical;
    }
}
