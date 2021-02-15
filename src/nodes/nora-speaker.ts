import { OnOffDevice, VolumeDevice } from '@andrei-tatar/nora-firebase-common';
import { Subject } from 'rxjs';
import { first, publishReplay, refCount, switchMap, takeUntil, tap } from 'rxjs/operators';
import { ConfigNode, NodeInterface } from '..';
import { FirebaseConnection } from '../firebase/connection';
import { getId, withLocalExecution } from './util';

module.exports = function (RED: any) {
    RED.nodes.registerType('noraf-speaker', function (this: NodeInterface, config: any) {
        RED.nodes.createNode(this, config);

        const noraConfig: ConfigNode = RED.nodes.getNode(config.nora);
        if (!noraConfig?.valid) { return; }

        const close$ = new Subject();
        const stateString$ = new Subject<string>();

        const deviceConfig = noraConfig.setCommon<VolumeDevice & OnOffDevice>({
            id: getId(config),
            type: 'action.devices.types.SPEAKER',
            traits: ['action.devices.traits.Volume', 'action.devices.traits.OnOff'] as never,
            name: {
                name: config.devicename,
            },
            roomHint: config.roomhint,
            willReportState: true,
            state: {
                on: false,
                online: true,
                currentVolume: 50,
                isMuted: false,
            },
            noraSpecific: {
            },
            attributes: {
                volumeCanMuteAndUnmute: false,
                volumeMaxLevel: 100,
                levelStepSize: parseInt(config.step, 10) || 1,
            },
        });

        const device$ = FirebaseConnection
            .withLogger(RED.log)
            .fromConfig(noraConfig, this, stateString$)
            .pipe(
                switchMap(connection => connection.withDevice(deviceConfig)),
                withLocalExecution(noraConfig),
                publishReplay(1),
                refCount(),
                takeUntil(close$),
            );

        device$.pipe(
            switchMap(d => d.state$),
            tap(state => notifyState(state)),
            takeUntil(close$),
        ).subscribe();

        device$.pipe(
            switchMap(d => d.stateUpdates$),
            takeUntil(close$),
        ).subscribe((state) => {
            this.send({
                payload: {
                    on: state.on,
                    volume: state.currentVolume,
                },
                topic: config.topic
            });
        });

        this.on('input', async msg => {
            if (config.passthru) {
                this.send(msg);
            }
            try {
                const device = await device$.pipe(first()).toPromise();
                await device.updateState(msg?.payload);
            } catch (err) {
                this.warn(`while updating state ${err.message}: ${err.stack}`);
            }
        });

        this.on('close', () => {
            close$.next();
            close$.complete();
        });

        function notifyState(state: (VolumeDevice & OnOffDevice)['state']) {
            stateString$.next(`(${state.on ? 'on' : 'off'}:${state.currentVolume})`);
        }
    });
};
