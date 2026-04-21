const { Client, GatewayIntentBits, ActivityType, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, getVoiceConnection } = require('@discordjs/voice');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

// Load environment variables
dotenv.config();

// Bot configuration
const config = {
    token: process.env.DISCORD_TOKEN,
    prefix: process.env.PREFIX || '!',
    clientId: process.env.CLIENT_ID,
    reconnectAttempts: 5,
    reconnectDelay: 5000
};

// Validate token
if (!config.token) {
    console.error('\x1b[31m%s\x1b[0m', '❌ ERROR: Discord token not found in .env file!');
    process.exit(1);
}

// Create Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// Store active connections and configurations
const voiceConnections = new Map();
const connectionConfigs = new Map();

// Logger utility
class Logger {
    static info(message) {
        console.log('\x1b[36m%s\x1b[0m', `[INFO] ${new Date().toLocaleTimeString()} - ${message}`);
    }
    
    static success(message) {
        console.log('\x1b[32m%s\x1b[0m', `[SUCCESS] ${new Date().toLocaleTimeString()} - ${message}`);
    }
    
    static error(message) {
        console.error('\x1b[31m%s\x1b[0m', `[ERROR] ${new Date().toLocaleTimeString()} - ${message}`);
    }
    
    static warn(message) {
        console.warn('\x1b[33m%s\x1b[0m', `[WARN] ${new Date().toLocaleTimeString()} - ${message}`);
    }
    
    static debug(message) {
        if (process.env.DEBUG === 'true') {
            console.log('\x1b[35m%s\x1b[0m', `[DEBUG] ${new Date().toLocaleTimeString()} - ${message}`);
        }
    }
}

// Error handler utility
class ErrorHandler {
    static async handleError(error, context = 'Unknown context') {
        Logger.error(`Error in ${context}: ${error.message}`);
        
        if (error.code === 'ECONNRESET') {
            Logger.warn('Connection reset detected, attempting recovery...');
            return { recoverable: true, delay: 5000 };
        }
        
        if (error.code === 'ETIMEDOUT') {
            Logger.warn('Connection timeout, retrying...');
            return { recoverable: true, delay: 3000 };
        }
        
        if (error.code === 40032) {
            Logger.warn('Target user not in voice channel');
            return { recoverable: false, message: '❌ Target user is not in a voice channel!' };
        }
        
        if (error.code === 40013) {
            Logger.warn('Bot lacks required permissions');
            return { recoverable: false, message: '❌ Bot lacks required permissions!' };
        }
        
        if (error.code === 50001) {
            Logger.warn('Missing access to voice channel');
            return { recoverable: false, message: '❌ Bot cannot access that voice channel!' };
        }
        
        Logger.error(`Unhandled error: ${error.stack}`);
        return { recoverable: false, message: '❌ An unexpected error occurred!' };
    }
}

// Voice connection manager
class VoiceConnectionManager {
    static async createConnection(guildId, channelId, options = {}) {
        try {
            const channel = client.channels.cache.get(channelId);
            if (!channel) {
                throw new Error(`Voice channel ${channelId} not found`);
            }

            // Check existing connection
            const existingConnection = getVoiceConnection(guildId);
            if (existingConnection) {
                Logger.debug(`Destroying existing connection for guild ${guildId}`);
                existingConnection.destroy();
            }

            const connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
                selfDeaf: options.selfDeaf !== false,
                selfMute: false,
                debug: process.env.DEBUG === 'true'
            });

            // Setup connection event handlers
            connection.on('stateChange', (oldState, newState) => {
                Logger.debug(`Voice connection state: ${oldState.status} → ${newState.status}`);
                
                if (newState.status === VoiceConnectionStatus.Disconnected) {
                    Logger.warn(`Voice connection disconnected in guild ${guildId}`);
                    
                    // Attempt to reconnect if auto-reconnect is enabled
                    if (options.autoReconnect !== false) {
                        setTimeout(() => {
                            VoiceConnectionManager.reconnect(guildId, channelId, options);
                        }, 5000);
                    }
                } else if (newState.status === VoiceConnectionStatus.Destroyed) {
                    Logger.info(`Voice connection destroyed in guild ${guildId}`);
                    voiceConnections.delete(guildId);
                    connectionConfigs.delete(guildId);
                } else if (newState.status === VoiceConnectionStatus.Ready) {
                    Logger.success(`Voice connection established in guild ${guildId}`);
                    voiceConnections.set(guildId, connection);
                    
                    // Start silent audio player for 24/7 operation
                    if (options.enablePlayer !== false) {
                        VoiceConnectionManager.startSilentPlayer(connection);
                    }
                }
            });

            connection.on('error', (error) => {
                Logger.error(`Voice connection error in guild ${guildId}: ${error.message}`);
            });

            // Wait for connection to be ready
            await entersState(connection, VoiceConnectionStatus.Ready, 30000);
            
            // Store connection config
            connectionConfigs.set(guildId, {
                channelId,
                options,
                joinedAt: Date.now()
            });

            return connection;
            
        } catch (error) {
            Logger.error(`Failed to create voice connection: ${error.message}`);
            throw error;
        }
    }

    static startSilentPlayer(connection) {
        try {
            const player = createAudioPlayer();
            
            // Create silent audio resource
            const silentBuffer = Buffer.alloc(1920); // 20ms of silence at 48kHz
            const resource = createAudioResource(silentBuffer, {
                inputType: 'arbitrary',
            });

            player.play(resource);
            connection.subscribe(player);

            player.on(AudioPlayerStatus.Idle, () => {
                Logger.debug('Audio player idle, restarting...');
                const newResource = createAudioResource(silentBuffer, {
                    inputType: 'arbitrary',
                });
                player.play(newResource);
            });

            player.on('error', (error) => {
                Logger.error(`Audio player error: ${error.message}`);
                setTimeout(() => {
                    const newResource = createAudioResource(silentBuffer, {
                        inputType: 'arbitrary',
                    });
                    player.play(newResource);
                }, 1000);
            });

            Logger.debug('Silent player started for 24/7 operation');
            
        } catch (error) {
            Logger.error(`Failed to start silent player: ${error.message}`);
        }
    }

    static async reconnect(guildId, channelId, options) {
        Logger.info(`Attempting to reconnect in guild ${guildId}`);
        
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                Logger.info(`Reconnection attempt ${attempt}/5...`);
                await VoiceConnectionManager.createConnection(guildId, channelId, options);
                Logger.success(`Successfully reconnected in guild ${guildId}`);
                return true;
            } catch (error) {
                Logger.error(`Reconnection attempt ${attempt} failed: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
            }
        }
        
        Logger.error(`Failed to reconnect after 5 attempts in guild ${guildId}`);
        return false;
    }

    static async leaveVoiceChannel(guildId) {
        try {
            const connection = getVoiceConnection(guildId);
            if (connection) {
                connection.destroy();
                voiceConnections.delete(guildId);
                connectionConfigs.delete(guildId);
                Logger.success(`Left voice channel in guild ${guildId}`);
                return true;
            }
            return false;
        } catch (error) {
            Logger.error(`Error leaving voice channel: ${error.message}`);
            return false;
        }
    }
}

// Command handler
class CommandHandler {
    static async handleJoinVoiceChannel(message, args) {
        try {
            const targetUser = message.mentions.users.first() || message.author;
            const member = await message.guild.members.fetch(targetUser.id);
            
            if (!member) {
                return message.reply('❌ User not found in this server!');
            }

            const voiceChannel = member.voice.channel;
            
            if (!voiceChannel) {
                return message.reply(`❌ ${targetUser.username} is not in a voice channel!`);
            }

            // Check permissions
            const permissions = voiceChannel.permissionsFor(client.user);
            if (!permissions.has(PermissionsBitField.Flags.Connect)) {
                return message.reply('❌ I don\'t have permission to join that voice channel!');
            }

            if (!permissions.has(PermissionsBitField.Flags.Speak)) {
                Logger.warn('Missing speak permission, but continuing with silent mode');
            }

            // Create voice connection
            const loadingMsg = await message.reply('🔄 Joining voice channel...');
            
            await VoiceConnectionManager.createConnection(message.guild.id, voiceChannel.id, {
                selfDeaf: true,
                autoReconnect: true,
                enablePlayer: true
            });

            // Update bot status to streaming
            client.user.setPresence({
                activities: [{
                    name: `🎵 VC: ${voiceChannel.name}`,
                    type: ActivityType.Streaming,
                    url: 'https://twitch.tv/discord'
                }],
                status: 'online'
            });

            // Create success embed
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('✅ Voice Channel Joined')
                .setDescription(`Successfully joined ${voiceChannel.name}`)
                .addFields(
                    { name: 'Channel', value: `${voiceChannel.name}`, inline: true },
                    { name: 'Target User', value: `${targetUser.username}`, inline: true },
                    { name: 'Status', value: '🔊 Connected & Deafened', inline: true },
                    { name: '24/7 Mode', value: '✅ Enabled', inline: true }
                )
                .setTimestamp()
                .setFooter({ text: 'VC Joiner Bot • Advanced Mode' });

            await loadingMsg.edit({ content: null, embeds: [embed] });
            
            Logger.success(`Bot joined VC: ${voiceChannel.name} in ${message.guild.name}`);

        } catch (error) {
            const errorResult = await ErrorHandler.handleError(error, 'JoinVoiceChannel');
            await message.reply(errorResult.message || '❌ Failed to join voice channel!');
        }
    }

    static async handleLeaveVoiceChannel(message) {
        try {
            const loadingMsg = await message.reply('🔄 Leaving voice channel...');
            
            const left = await VoiceConnectionManager.leaveVoiceChannel(message.guild.id);
            
            if (left) {
                // Reset bot status
                client.user.setPresence({
                    activities: [{
                        name: `${config.prefix}help | 24/7 Ready`,
                        type: ActivityType.Streaming,
                        url: 'https://twitch.tv/discord'
                    }],
                    status: 'online'
                });

                const embed = new EmbedBuilder()
                    .setColor(0xFFA500)
                    .setTitle('👋 Voice Channel Left')
                    .setDescription('Successfully disconnected from voice channel')
                    .setTimestamp();

                await loadingMsg.edit({ content: null, embeds: [embed] });
                Logger.success(`Bot left VC in ${message.guild.name}`);
            } else {
                await loadingMsg.edit('❌ Bot is not in a voice channel!');
            }

        } catch (error) {
            const errorResult = await ErrorHandler.handleError(error, 'LeaveVoiceChannel');
            await message.reply(errorResult.message || '❌ Failed to leave voice channel!');
        }
    }

    static async handleStatus(message) {
        try {
            const connection = getVoiceConnection(message.guild.id);
            const config = connectionConfigs.get(message.guild.id);
            
            if (!connection || !config) {
                return message.reply('❌ Bot is not connected to any voice channel!');
            }

            const channel = client.channels.cache.get(config.channelId);
            const duration = Math.floor((Date.now() - config.joinedAt) / 1000);
            const hours = Math.floor(duration / 3600);
            const minutes = Math.floor((duration % 3600) / 60);
            const seconds = duration % 60;

            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('📊 Voice Connection Status')
                .addFields(
                    { name: 'Channel', value: channel ? channel.name : 'Unknown', inline: true },
                    { name: 'Guild', value: message.guild.name, inline: true },
                    { name: 'Connected Since', value: `${hours}h ${minutes}m ${seconds}s`, inline: true },
                    { name: 'Connection State', value: connection.state.status, inline: true },
                    { name: 'Self Deafened', value: '✅ Yes', inline: true },
                    { name: '24/7 Mode', value: '✅ Active', inline: true },
                    { name: 'Auto Reconnect', value: '✅ Enabled', inline: true },
                    { name: 'Latency', value: `${client.ws.ping}ms`, inline: true }
                )
                .setTimestamp()
                .setFooter({ text: 'VC Joiner Bot • Advanced Mode' });

            await message.reply({ embeds: [embed] });

        } catch (error) {
            Logger.error(`Error in status command: ${error.message}`);
            await message.reply('❌ Failed to fetch status!');
        }
    }

    static async handleHelp(message) {
        const embed = new EmbedBuilder()
            .setColor(0x800080)
            .setTitle('🤖 VC Joiner Bot - Commands')
            .setDescription('Advanced Voice Channel Joiner with 24/7 Capability')
            .addFields(
                { 
                    name: `${config.prefix}jvc [@user]`, 
                    value: 'Join voice channel of mentioned user or yourself\n`!jvc @username` or `!jvc`', 
                    inline: false 
                },
                { 
                    name: `${config.prefix}lvc`, 
                    value: 'Leave current voice channel\n`!lvc`', 
                    inline: false 
                },
                { 
                    name: `${config.prefix}status`, 
                    value: 'Show current voice connection status\n`!status`', 
                    inline: false 
                },
                { 
                    name: `${config.prefix}ping`, 
                    value: 'Check bot latency\n`!ping`', 
                    inline: false 
                },
                { 
                    name: `${config.prefix}help`, 
                    value: 'Show this help message\n`!help`', 
                    inline: false 
                }
            )
            .addFields({
                name: '✨ Features',
                value: '• 24/7 Voice Channel Stay\n• Auto Reconnect on Disconnect\n• Self Deafened Mode\n• Streaming Status\n• Advanced Error Handling\n• Silent Audio Player',
                inline: false
            })
            .setTimestamp()
            .setFooter({ text: 'Made with ❤️ | Advanced VC Bot' });

        await message.reply({ embeds: [embed] });
    }
}

// Bot event handlers
client.once('ready', () => {
    Logger.success(`✅ ${client.user.tag} is online and ready!`);
    Logger.info(`Bot ID: ${client.user.id}`);
    Logger.info(`Servers: ${client.guilds.cache.size}`);
    Logger.info(`Prefix: ${config.prefix}`);

    // Set initial status
    client.user.setPresence({
        activities: [{
            name: `${config.prefix}help | 24/7 Ready`,
            type: ActivityType.Streaming,
            url: 'https://twitch.tv/discord'
        }],
        status: 'online'
    });

    // Display connection info
    Logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    Logger.info('🤖 VC Joiner Bot is fully operational!');
    Logger.info('📋 Commands:');
    Logger.info(`   ${config.prefix}jvc - Join voice channel`);
    Logger.info(`   ${config.prefix}lvc - Leave voice channel`);
    Logger.info(`   ${config.prefix}status - Check connection status`);
    Logger.info(`   ${config.prefix}help - Show all commands`);
    Logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

// Message handler
client.on('messageCreate', async (message) => {
    // Ignore bot messages and DMs
    if (message.author.bot || !message.guild) return;

    // Check for prefix
    if (!message.content.startsWith(config.prefix)) return;

    const args = message.content.slice(config.prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    Logger.debug(`Command received: ${command} from ${message.author.tag}`);

    try {
        switch (command) {
            case 'jvc':
                await CommandHandler.handleJoinVoiceChannel(message, args);
                break;
                
            case 'lvc':
                await CommandHandler.handleLeaveVoiceChannel(message);
                break;
                
            case 'status':
                await CommandHandler.handleStatus(message);
                break;
                
            case 'ping':
                const pingEmbed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('🏓 Pong!')
                    .setDescription(`Latency: ${client.ws.ping}ms`)
                    .setTimestamp();
                await message.reply({ embeds: [pingEmbed] });
                break;
                
            case 'help':
                await CommandHandler.handleHelp(message);
                break;
                
            default:
                await message.reply(`❌ Unknown command! Use \`${config.prefix}help\` for command list.`);
        }
    } catch (error) {
        Logger.error(`Command execution error: ${error.message}`);
        await message.reply('❌ An error occurred while executing the command!').catch(() => {});
    }
});

// Voice state update handler for auto-reconnect
client.on('voiceStateUpdate', async (oldState, newState) => {
    // Check if bot was disconnected
    if (oldState.member?.id === client.user.id && oldState.channelId && !newState.channelId) {
        Logger.warn(`Bot was disconnected from VC in guild ${oldState.guild.id}`);
        
        const config = connectionConfigs.get(oldState.guild.id);
        if (config && config.options.autoReconnect) {
            Logger.info(`Attempting auto-reconnect to channel ${config.channelId}`);
            setTimeout(async () => {
                try {
                    await VoiceConnectionManager.createConnection(
                        oldState.guild.id,
                        config.channelId,
                        config.options
                    );
                } catch (error) {
                    Logger.error(`Auto-reconnect failed: ${error.message}`);
                }
            }, 5000);
        }
    }
});

// Error handling for the client
client.on('error', (error) => {
    Logger.error(`Client error: ${error.message}`);
});

client.on('shardError', (error) => {
    Logger.error(`Shard error: ${error.message}`);
});

// Process error handlers
process.on('unhandledRejection', (error) => {
    Logger.error(`Unhandled rejection: ${error.message}`);
    Logger.error(error.stack);
});

process.on('uncaughtException', (error) => {
    Logger.error(`Uncaught exception: ${error.message}`);
    Logger.error(error.stack);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    Logger.warn('Received SIGINT signal, shutting down gracefully...');
    
    // Leave all voice channels
    for (const [guildId] of voiceConnections) {
        await VoiceConnectionManager.leaveVoiceChannel(guildId);
    }
    
    Logger.info('Bot shutdown complete');
    process.exit(0);
});

// Login to Discord
client.login(config.token).catch(error => {
    Logger.error(`Failed to login: ${error.message}`);
    process.exit(1);
});
