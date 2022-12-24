import RtcManagerDispatcher, {
    RtcEvents,
    RtcManagerCreatedPayload,
    RtcStreamAddedPayload,
} from "@whereby/jslib-commons/src/webrtc/RtcManagerDispatcher";
import RtcManager from "@whereby/jslib-commons/src/webrtc/RtcManager";
import { fromLocation } from "@whereby/jslib-commons/src/utils/urls";
import {
    ApiClient,
    CredentialsService,
    OrganizationApiClient,
    OrganizationService,
    OrganizationServiceCache,
    RoomService,
} from "@whereby/jslib-api";
import { LocalParticipant, RemoteParticipant } from "./RoomParticipant";

import ServerSocket, {
    ClientLeftEvent,
    NewClientEvent,
    RoomJoinedEvent as SignalRoomJoinedEvent,
} from "@whereby/jslib-commons/src/utils/ServerSocket";

interface Logger {
    log: (msg: string) => void;
}

export interface RoomConnectionOptions {
    displayName?: string; // Might not be needed at all
    localStream?: MediaStream;
    localMediaConstraints?: MediaStreamConstraints;
    roomKey?: string;
    logger?: Logger;
}

type RoomJoinedEvent = {
    localParticipant: LocalParticipant;
    remoteParticipants: RemoteParticipant[];
};

type ParticipantJoinedEvent = {
    remoteParticipant: RemoteParticipant;
};

type ParticipantLeftEvent = {
    participantId: string;
};

type ParticipantStreamAddedEvent = {
    participantId: string;
    stream: MediaStream;
};

type ParticipantAudioEnabledEvent = {
    participantId: string;
    isAudioEnabled: boolean;
};

interface RoomEventsMap {
    participant_audio_enabled: CustomEvent<ParticipantAudioEnabledEvent>;
    participant_joined: CustomEvent<ParticipantJoinedEvent>;
    participant_left: CustomEvent<ParticipantLeftEvent>;
    participant_stream_added: CustomEvent<ParticipantStreamAddedEvent>;
    room_joined: CustomEvent<RoomJoinedEvent>;
}

const API_BASE_URL = "https://ip-127-0-0-1.hereby.dev:4090";
const SIGNAL_BASE_URL = "wss://ip-127-0-0-1.hereby.dev:4070";

function createSocket() {
    const parsedUrl = new URL(SIGNAL_BASE_URL);
    const path = `${parsedUrl.pathname.replace(/^\/$/, "")}/protocol/socket.io/v1`;
    const SOCKET_HOST = parsedUrl.origin;

    const socketConf = {
        host: SOCKET_HOST,
        path,
        reconnectionDelay: 5000,
        reconnectionDelayMax: 30000,
        timeout: 10000,
    };

    return new ServerSocket(SOCKET_HOST, socketConf);
}

/*
 * This is the topmost interface when dealing with Whereby.
 *
 */
interface RoomEventTarget extends EventTarget {
    addEventListener<K extends keyof RoomEventsMap>(
        type: K,
        listener: (ev: RoomEventsMap[K]) => void,
        options?: boolean | AddEventListenerOptions
    ): void;
    addEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: EventListenerOptions | boolean
    ): void;
}

const TypedEventTarget = EventTarget as { new (): RoomEventTarget };
export default class RoomConnection extends TypedEventTarget {
    public localParticipant: LocalParticipant | null = null;
    public roomUrl: URL;
    public remoteParticipants: RemoteParticipant[] = [];
    public readonly localMediaConstraints?: MediaStreamConstraints;

    private credentialsService: CredentialsService;
    private apiClient: ApiClient;
    private organizationService: OrganizationService;
    private organizationServiceCache: OrganizationServiceCache;
    private organizationApiClient: OrganizationApiClient;
    private roomService: RoomService;

    private signalSocket: ServerSocket;
    private rtcManagerDispatcher?: RtcManagerDispatcher;
    private rtcManager?: RtcManager;
    private roomConnectionState: "" | "connecting" | "connected" | "disconnected" = "";
    private logger: Logger;
    private localStream?: MediaStream;

    constructor(roomUrl: string, { localMediaConstraints, localStream, logger }: RoomConnectionOptions) {
        super();
        this.roomUrl = new URL(roomUrl); // Throw if invalid Whereby room url
        this.logger = logger || {
            log: () => {
                return;
            },
        };
        this.localStream = localStream;
        this.localMediaConstraints = localMediaConstraints;

        const urls = fromLocation({ host: this.roomUrl.host });

        // Initialize services
        this.credentialsService = CredentialsService.create({ baseUrl: API_BASE_URL });
        this.apiClient = new ApiClient({
            fetchDeviceCredentials: this.credentialsService.getCredentials.bind(this.credentialsService),
            baseUrl: API_BASE_URL,
        });
        this.organizationService = new OrganizationService({ apiClient: this.apiClient });
        this.organizationServiceCache = new OrganizationServiceCache({
            organizationService: this.organizationService,
            subdomain: urls.subdomain,
        });
        this.organizationApiClient = new OrganizationApiClient({
            apiClient: this.apiClient,
            fetchOrganization: async () => {
                const organization = await this.organizationServiceCache.fetchOrganization();
                return organization || undefined;
            },
        });
        this.roomService = new RoomService({ organizationApiClient: this.organizationApiClient });

        // Create signal socket and set up event listeners
        this.signalSocket = createSocket();
        this.signalSocket.on("new_client", this._handleNewClient.bind(this));
        this.signalSocket.on("client_left", this._handleClientLeft.bind(this));
        this.signalSocket.on("audio_enabled", this._handleClientAudioEnabled.bind(this));
    }

    private _handleNewClient({ client }: NewClientEvent) {
        const remoteParticipant = new RemoteParticipant({ ...client, newJoiner: true });
        this.remoteParticipants = [...this.remoteParticipants, remoteParticipant];
        this._handleAcceptStreams([remoteParticipant]);
        this.dispatchEvent(new CustomEvent("participant_joined", { detail: { remoteParticipant } }));
    }

    private _handleClientLeft({ clientId }: ClientLeftEvent) {
        const remoteParticipant = this.remoteParticipants.find((p) => p.id === clientId);
        this.remoteParticipants = this.remoteParticipants.filter((p) => p.id !== clientId);
        if (!remoteParticipant) {
            return;
        }
        this.dispatchEvent(new CustomEvent("participant_left", { detail: { participantId: remoteParticipant.id } }));
    }

    private _handleClientAudioEnabled({ clientId, isAudioEnabled }: { clientId: string; isAudioEnabled: boolean }) {
        const remoteParticipant = this.remoteParticipants.find((p) => p.id === clientId);
        if (!remoteParticipant) {
            return;
        }
        this.dispatchEvent(
            new CustomEvent("participant_audio_enabled", {
                detail: { participantId: remoteParticipant.id, isAudioEnabled },
            })
        );
    }

    private _handleRtcEvent<K extends keyof RtcEvents>(eventName: K, data: RtcEvents[K]) {
        this.logger.log(`Got RTC event ${eventName}`);

        if (eventName === "rtc_manager_created") {
            const typedData = data as RtcManagerCreatedPayload;
            this.rtcManager = typedData.rtcManager;

            if (this.rtcManager && this.localStream) {
                this.rtcManager.addNewStream(
                    "0",
                    this.localStream,
                    !this.localStream?.getAudioTracks().find((t) => t.enabled),
                    !this.localStream?.getVideoTracks().find((t) => t.enabled)
                );
            }

            // Handle any existing remote participants
            if (this.remoteParticipants.length) {
                this._handleAcceptStreams(this.remoteParticipants);
            }
        }

        if (eventName === "stream_added") {
            const typedData = data as RtcStreamAddedPayload;
            this._handleStreamAdded(typedData);
        }
    }

    private _handleAcceptStreams(remoteParticipants: RemoteParticipant[]) {
        remoteParticipants.forEach((participant) => {
            const { streams, id: participantId } = participant;
            streams.forEach((stream) => {
                const { id: streamId, state } = stream;
                if (state !== "done_accept") {
                    //const newState = `${newJoiner && streamId === "0" ? "new" : "to"}_accept`
                    this.logger.log(`Accepting stream ${streamId} from ${participantId}`);
                    this.rtcManager?.acceptNewStream({
                        streamId: streamId === "0" ? participantId : streamId,
                        clientId: participantId,
                        shouldAddLocalVideo: streamId === "0",
                        activeBreakout: false,
                    });
                }
            });
        });
    }

    private _handleStreamAdded({
        clientId,
        stream,
        streamId,
    }: {
        clientId: string;
        stream: MediaStream;
        streamId: string;
    }) {
        const remoteParticipant = this.remoteParticipants.find((p) => p.id === clientId);
        if (!remoteParticipant) {
            this.logger.log("WARN: Could not find participant for incoming stream");
            return;
        }

        this.dispatchEvent(
            new CustomEvent("participant_stream_added", { detail: { participantId: clientId, stream, streamId } })
        );
    }

    async join(): Promise<void> {
        if (["connected", "connecting"].includes(this.roomConnectionState)) {
            console.warn(`Trying to join room state is ${this.roomConnectionState}`);
            return;
        }

        this.logger.log("Joining room");
        this.roomConnectionState = "connecting";

        if (!this.localStream && this.localMediaConstraints) {
            const localStream = await navigator.mediaDevices.getUserMedia(this.localMediaConstraints);
            this.localStream = localStream;
        }

        const organization = await this.organizationServiceCache.fetchOrganization();
        if (!organization) {
            throw new Error("Invalid room url");
        }

        // TODO: Get room permissions
        // TODO: Get room features

        const webrtcProvider = {
            getMediaConstraints: () => ({
                audio: !!this.localStream?.getAudioTracks().find((t) => t.enabled),
                video: !!this.localStream?.getVideoTracks().find((t) => t.enabled),
            }),
            deferrable(clientId: string) {
                return !clientId;
            },
        };

        this.rtcManagerDispatcher = new RtcManagerDispatcher({
            emitter: {
                emit: this._handleRtcEvent.bind(this),
            },
            serverSocket: this.signalSocket,
            webrtcProvider,
            features: {
                deferDrySfuSubscriptions: true,
                deprioritizeH264OnSafari: false,
                enforceTurnTls: false,
                floodProtectionOn: true,
                lowDataModeEnabled: false,
                nativeREMB: true,
                opusDtx: false,
                reconnectFix: true,
                simplifiedVegaClientOn: false,
                sfuServerOverrideHost: undefined,
                turnServerOverrideHost: undefined,
                useOnlyTURN: undefined,
                vp9On: false,
                clientObserverOn: true,
                observerStagingOn: false,
            },
        });

        // Identify device on signal connection
        const deviceCredentials = await this.credentialsService.getCredentials();
        this.signalSocket.connect();

        // TODO: Clean up so we dont need to explicitly wait for socket connection
        setTimeout(() => {
            this.signalSocket.emit("identify_device", { deviceCredentials });
            this.signalSocket.once("device_identified", () => {
                this.signalSocket.emit("join_room", {
                    config: {
                        isAudioEnabled: !!this.localStream?.getAudioTracks().find((t) => t.enabled),
                        isVideoEnabled: !!this.localStream?.getVideoTracks().find((t) => t.enabled),
                    },
                    organizationId: organization.organizationId,
                    roomName: this.roomUrl.pathname,
                    displayName: "SDK",
                });
                this.signalSocket.once("room_joined", (res: SignalRoomJoinedEvent) => {
                    const {
                        selfId,
                        room: { clients },
                    } = res;

                    const localClient = clients.find((c) => c.id === selfId);
                    if (!localClient) throw new Error("Missing local client");

                    this.localParticipant = new LocalParticipant({ ...localClient, stream: this.localStream });
                    this.remoteParticipants = clients
                        .filter((c) => c.id !== selfId)
                        .map((c) => new RemoteParticipant({ ...c, newJoiner: false }));

                    // Accept remote streams if RTC manager has been initialized
                    if (this.rtcManager) {
                        this._handleAcceptStreams(this.remoteParticipants);
                    }

                    this.dispatchEvent(
                        new CustomEvent("room_joined", {
                            detail: {
                                localParticipant: this.localParticipant,
                                remoteParticipants: this.remoteParticipants,
                            },
                        })
                    );
                });
            });
        }, 1000);

        return;
    }

    leave(): Promise<void> {
        return new Promise<void>((resolve) => {
            if (!this.signalSocket) {
                return resolve();
            }

            this.signalSocket.emit("leave_room");
            const leaveTimeout = setTimeout(() => {
                resolve();
            }, 200);
            this.signalSocket.once("room_left", () => {
                clearTimeout(leaveTimeout);
                this.signalSocket.disconnect();
                resolve();
            });
        });
    }
}
