const Listener      = require( "Listener" );
const Promise       = require( "bluebird" );
const Respawn       = require( "respawn" );
const url           = require( "url" );
const fs            = require( "fs" ) ;
const mqtt          = require('mqtt');

const log           = require( "debug" )( "app:camera:log" );
const error		    = require( "debug" )( "app:camera:error" );

const dLog		    = require( "debug" )( "app:daemon:log" );
const dError		= require( "debug" )( "app:daemon:error" );

class Camera
{
    constructor( serial, devicePath, wsPort, configuration )
    {
        // Camera properties
        this.serial     = serial;
        this.devicePath = devicePath;
        this.wsPort     = wsPort;
        this.alive      = true;

        // Config
        this.sslInfo    = configuration.sslInfo;
        this.settings   = configuration.cameraSettings;
        this.sioServer  = configuration.sioServer;
        this.eventBus   = configuration.eventBus;

        let months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        let d = new Date();
        this.ts = d.getDate() + months[d.getMonth()] + d.getHours() + d.getMinutes();

        // Mqtt info
        this.mqttConnected = false;
        this.mqttUri    = 'ws://127.0.0.1:3000';

        // Mock mode info
        this.useMock            = configuration.useMock;

        // Create process daemon
        this.daemon = Respawn( this.getDaemonCommand(),
        {
            name:           'mjpg-streamer',
            maxRestarts:    5,
            sleep:          5000,
            env:            {"LD_LIBRARY_PATH": "/usr/local/lib",
            "PATH": "/bin:/sbin:/usr/bin:/usr/sbin:/usr/local/bin:/usr/local/sbin"}
        });

        // Promisify start and stop
        this.daemon.startAsync  = Promise.promisify( this.daemon.start );
        this.daemon.stopAsync   = Promise.promisify( this.daemon.stop );

        // Set up daemon listeners
        this.daemon.on( "crash", () =>
        {
            dError( "Camera crashed too many times. Disabling." );

            // Camera has crashed too many times. Kill it.
            this.kill();
        });

        this.daemon.on( "stderr", (data) =>
        {
            dError( data.toString() );
        });

        this.listeners =
        {
            registration: new Listener( this.eventBus, "broadcastRegistration", false, () =>
            {
                if( this.alive === true )
                {
                    log( "Sending registration" );
                    let extCam = url.parse(this.devicePath);

                    // Send registration message
                    this.sioServer.emit( "stream.registration", this.serial,
                    {
                        port:		        this.wsPort,
                        resolution: 		this.settings.resolution,
                        framerate: 			this.settings.framerate,
                        connectionType:     ( this.useMock || this.serial === 'pilot' ? "ws" : "http" )
                    });

                    // send camera info to elphel-config plugin
                    let camMap = `${this.wsPort}:${extCam.hostname}:${this.serial}:${this.ts}`;
                    if (this.mqttConnected === true) {
                        this.client.publish('toCamera/cameraRegistration', camMap);
                    }
                }
            }),

            settings: new Listener( this.eventBus, "updateSettings", false, ( settings ) =>
            {
                log( "Received camera settings update" );

                this.settings = settings;

                // Restart camera
                this.restart()
                    .catch( (err) =>
                    {
                        error( `Error restarting camera: ${err.message}` );
                    });
            })
        }

        this.listeners.registration.enable();
        this.listeners.settings.enable();

        // Connect to MQTT broker and setup all event handlers
        // This is used to publish camera settings to camera viewers for controls
        this.client = mqtt.connect(this.mqttUri, {
            protocolVersion: 4,
            resubscribe: true,
            will: {
                topic: 'status/openrov',
                payload: 'MJPEG-VIDEO-SERVER: OpenROV MQTT client disconnected!',
                qos: 0,
                retain: false
            }
        });

        this.client.on('connect', () => {
            this.mqttConnected = true;
            log('MJPEG-VIDEO-SERVER: MQTT broker connection established!');
        });

        this.client.on('reconnect', () => {
            this.mqttConnected = true;
            log('MJPEG-VIDEO-SERVER: MQTT broker re-connected!');
        });

        this.client.on('offline', () => {
            this.mqttConnected = false;
            log('MJPEG-VIDEO-SERVER: MQTT broker connection offline!');
        });

        this.client.on('close', () => {
            // connection state is also set to false in class close() method
            this.mqttConnected = false;
            log('MJPEG-VIDEO-SERVER: MQTT broker connection closed!');
        });

        this.client.on('error', (err) => {
            log('MJPEG-VIDEO-SERVER: MQTT error: ', err);
        });
    };

    getDaemonCommand()
    {
        if( this.useMock )
        {
            return [
                "nice", "--19",
                "mjpg_streamer",
                "-i", `input_uvc.so -r ${this.settings.resolution} -f ${this.settings.framerate} -d ${this.devicePath}`,
                "-o", `output_ws.so -p ${this.wsPort}`
            ];
        }
        // if true, devicePath passed by Supervisor = camera URL rather than device path on filesystem
        else if ( process.env.EXTERNAL_CAM )
        {
            let extCam = url.parse(this.devicePath);

            let newParent = '/opt/openrov/images/' + this.ts;
            if (!fs.existsSync(newParent))
            {
                fs.mkdirSync(newParent, '0775');
            }
            let newChild = newParent + '/' + this.serial;
            if (!fs.existsSync(newChild))
            {
                fs.mkdirSync(newChild, '0775');
            }

            if (this.settings.record && this.serial == 'pilot')
            {
                return [
                    "nice", "--19",
                    "mjpg_streamer",
                    "-i", `input_http.so -p ${extCam.port} -H ${extCam.hostname} -u ${extCam.path}`,
                    "-o", `output_ws.so -p ${this.wsPort}`,
                    "-o", `output_file.so -f ${newChild}`
                ];
            }
            else if (this.settings.record && this.serial != 'pilot')
            {
                return [
                    "nice", "--19",
                    "mjpg_streamer",
                    "-i", `input_http.so -p ${extCam.port} -H ${extCam.hostname} -u ${extCam.path}`,
                    "-o", `output_http.so -p ${this.wsPort} -w /opt/openrov/www`,
                    "-o", `output_file.so -f ${newChild}`
                ];
            }
            else if (!this.settings.record && this.serial == 'pilot')
            {
                return [
                    "nice", "--19",
                    "mjpg_streamer",
                    "-i", `input_http.so -p ${extCam.port} -H ${extCam.hostname} -u ${extCam.path}`,
                    "-o", `output_ws.so -p ${this.wsPort}`
                ];
            }
            else
            {
                return [
                    "nice", "--19",
                    "mjpg_streamer",
                    "-i", `input_http.so -p ${extCam.port} -H ${extCam.hostname} -u ${extCam.path}`,
                    "-o", `output_http.so -p ${this.wsPort} -w /opt/openrov/www`
                ];
            }
        }
        else    // USB camera
        {
            // Uses SSL
            return [
                "nice", "--19",
                "mjpg_streamer",
                "-i", `input_uvc.so -r ${this.settings.resolution} -f ${this.settings.framerate} -d ${this.devicePath}`,
                "-o", `output_ws.so -p ${this.wsPort} -s -c ${this.sslInfo.certPath} -k ${this.sslInfo.keyPath}`
            ];
        }
    }

    start()
    {
        log( "Starting camera daemon" );
        return this.daemon.startAsync();
    }

    stop()
    {
        log( "Stopping camera daemon" );
        return this.daemon.stopAsync();
    }

    restart()
    {
        log( "Restarting camera daemon" );
        return this.stop()
                .then( () =>
                {
                    // Update the daemon command, in case settings changed
                    this.daemon.command = this.getDaemonCommand();
                    log( `Daemon command: ${this.daemon.command}` );
                })
                .then( () =>
                {
                    return this.start();
                });
    }

    kill()
    {
        this.alive = false;
    }
};

module.exports = Camera;
