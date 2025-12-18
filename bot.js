// ======================================================
// SourSound — Sremote v1.7.0
// ======================================================

require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder,
        ActionRowBuilder, ButtonBuilder, ButtonStyle,
        StringSelectMenuBuilder } = require("discord.js");

const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    StreamType,
    getVoiceConnection,
    AudioPlayerStatus
} = require("@discordjs/voice");

const ffmpeg = require("ffmpeg-static");
const { spawn } = require("child_process");

const PREFIX = "S";

// -------------------- Client --------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
    ],
});

// -------------------- State --------------------
const players = new Map();         
const ffmpegProcs = new Map();   
const remoteMessages = new Map(); 
const settings = new Map();        
const presetIndex = new Map();   

// -------------------- Presets --------------------
const presets = [
    {
        id: "deep-rumble",
        label: "Deep Rumble",
        description: "Very low, deep, sub-bass rumble",
        type: "brown",
        lowpass: 250,
        highpass: 2,
        volume: 0.6,
    },
    {
        id: "soft-breeze",
        label: "Soft Breeze",
        description: "Soft, airy — great for sleeping",
        type: "pink",
        lowpass: 1500,
        highpass: 0,
        volume: 0.3,
    },
    {
        id: "smooth-brown",
        label: "Smooth Brown",
        description: "Balanced brown noise — warm & steady",
        type: "brown",
        lowpass: 800,
        highpass: 10,
        volume: 0.4,
    },
    {
        id: "wind-tunnel",
        label: "Wind Tunnel",
        description: "Whooshing like inside an airplane cabin",
        type: "pink",
        lowpass: 3000,
        highpass: 40,
        volume: 0.5,
    },
    {
        id: "bright-hiss",
        label: "Bright Hiss",
        description: "Sharper, high-frequency static-like hiss",
        type: "white",
        lowpass: 12000,
        highpass: 200,
        volume: 0.5,
    }
];

// -------------------- Helpers --------------------
function getSettings(guildId) {
    if (!settings.has(guildId)) {
        settings.set(guildId, {
            type: "brown",
            lowpass: 800,
            highpass: 10,
            volume: 0.4,
            preset: "smooth-brown",
        });
    }
    return settings.get(guildId);
}

function clampVolume(v) {
    if (Number.isNaN(v)) return 0.4;
    return Math.min(Math.max(v, 0.0), 1.0);
}

function clampFreq(f) {
    if (Number.isNaN(f)) return 800;
    return Math.max(1, Math.floor(f));
}

function killFfmpeg(guildId) {
    const proc = ffmpegProcs.get(guildId);
    if (proc && !proc.killed) {
        try { proc.kill("SIGKILL"); } catch (e) { }
    }
    ffmpegProcs.delete(guildId);
}

function playCurrent(guildId, voiceChannel) {
    const s = getSettings(guildId);

    s.volume = clampVolume(s.volume);
    s.lowpass = clampFreq(s.lowpass);
    s.highpass = clampFreq(s.highpass);

    const source = `anoisesrc=color=${s.type}:sample_rate=48000`;
    const filter = `lowpass=f=${s.lowpass},highpass=f=${s.highpass},volume=${s.volume}`;

    killFfmpeg(guildId);

    const proc = spawn(ffmpeg, [
        "-re",        
        "-f", "lavfi",
        "-i", source,
        "-af", filter,
        "-ar", "48000",
        "-ac", "2",
        "-f", "s16le",
        "-acodec", "pcm_s16le",
        "pipe:1"
    ], { windowsHide: true });

    ffmpegProcs.set(guildId, proc);

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator
    });

    let player = players.get(guildId);
    if (!player) {
        player = createAudioPlayer();
        players.set(guildId, player);
        connection.subscribe(player);

        player.on(AudioPlayerStatus.Idle, () => {
        });
    }

    const resource = createAudioResource(proc.stdout, {
        inputType: StreamType.Raw
    });

    player.play(resource);
}

function buildRemoteEmbed(guildId) {
    const s = getSettings(guildId);
    const presetMeta = presets.find(p => p.id === s.preset) || null;

    const embed = new EmbedBuilder()
        .setTitle("🔊 SourSound — Remote Control")
        .setColor("#00f7ff")
        .addFields(
            { name: "Preset", value: `${presetMeta ? presetMeta.label : "Custom"}`, inline: true },
            { name: "Noise Type", value: `${s.type}`, inline: true },
            { name: "Volume", value: `${s.volume.toFixed(2)}`, inline: true },
            { name: "Lowpass", value: `${s.lowpass} Hz`, inline: true },
            { name: "Highpass", value: `${s.highpass} Hz`, inline: true },
        )
        .setFooter({ text: "Fine buttons change small steps; Coarse buttons change larger steps." });

    if (presetMeta) embed.setDescription(presetMeta.description);

    return embed;
}

function buildRemoteComponents(guildId) {
    const presetOptions = presets.map(p => ({
        label: p.label,
        value: `preset:${p.id}`,
        description: p.description.slice(0, 50)
    }));

    const presetRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`select:preset:${guildId}`)
            .setPlaceholder("Choose preset")
            .addOptions(presetOptions)
    );

    const typeRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`select:type:${guildId}`)
            .setPlaceholder("Noise type")
            .addOptions([
                { label: "Brown (deep)", value: `type:brown` },
                { label: "Pink (balanced)", value: `type:pink` },
                { label: "White (bright)", value: `type:white` }
            ])
    );

    const lowpassRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`lowpass:dec:coarse:${guildId}`).setLabel("-500").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`lowpass:dec:fine:${guildId}`).setLabel("-100").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`lowpass:inc:fine:${guildId}`).setLabel("+100").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`lowpass:inc:coarse:${guildId}`).setLabel("+500").setStyle(ButtonStyle.Primary)
    );

    const highpassRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`highpass:dec:coarse:${guildId}`).setLabel("-50").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`highpass:dec:fine:${guildId}`).setLabel("-10").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`highpass:inc:fine:${guildId}`).setLabel("+10").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`highpass:inc:coarse:${guildId}`).setLabel("+50").setStyle(ButtonStyle.Primary)
    );

    const volumeControlRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`volume:dec:coarse:${guildId}`).setLabel("-0.10").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`volume:inc:coarse:${guildId}`).setLabel("+0.10").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`control:play:${guildId}`).setLabel("▶ Play").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`control:stop:${guildId}`).setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`control:leave:${guildId}`).setLabel("👋 Leave").setStyle(ButtonStyle.Secondary)
    );

    return [presetRow, typeRow, lowpassRow, highpassRow, volumeControlRow];
}


async function sendOrUpdateRemote(msg) {
    const guildId = msg.guild.id;
    const channel = msg.channel;
    const embed = buildRemoteEmbed(guildId);
    const components = buildRemoteComponents(guildId);

    const existing = remoteMessages.get(guildId);
    if (existing) {
        try {
            const channelRef = await client.channels.fetch(existing.channelId).catch(()=>null);
            if (channelRef) {
                const messageRef = await channelRef.messages.fetch(existing.messageId).catch(()=>null);
                if (messageRef) {
                    await messageRef.edit({ embeds: [embed], components });
                    return messageRef;
                }
            }
        } catch (e) {
        }
    }

    const sent = await channel.send({ embeds: [embed], components });
    remoteMessages.set(guildId, { channelId: channel.id, messageId: sent.id });
    return sent;
}

function playFromPreset(preset, guildId, voiceChannel) {
    // apply preset settings and play
    const s = getSettings(guildId);
    s.type = preset.type;
    s.lowpass = preset.lowpass;
    s.highpass = preset.highpass;
    s.volume = preset.volume;
    s.preset = preset.id;

    playCurrent(guildId, voiceChannel);
}

client.on("messageCreate", async (msg) => {
    if (!msg.content.startsWith(PREFIX)) return;

    const args = msg.content.substring(PREFIX.length).trim().split(/ +/);
    const rawCmd = args.shift();
    if (!rawCmd) return;
    const cmd = rawCmd.toLowerCase();

    const voiceChannel = msg.member?.voice?.channel;

    // HEP
    if (cmd === "help" || cmd === "shelp") {
        return msg.reply(`
\`\`\`
SourSound Commands (Prefix: S)

Sremote         → open the interactive remote control panel
Snoises         → open the quick presets selector (reaction menu)
Splay <name>    → play a preset by name (e.g. Splay soft-breeze)
Sstop           → stop playback
Sleave          → disconnect bot
Sstatus         → show current settings

Preset names:
deep-rumble, soft-breeze, smooth-brown, wind-tunnel, bright-hiss

Use Sremote for fine control (lowpass, highpass, volume, type).
\`\`\`
        `);
    }

    if (cmd === "status") {
        const s = getSettings(msg.guild.id);
        return msg.reply({
            embeds: [ buildRemoteEmbed(msg.guild.id) ]
        });
    }

    if (cmd === "noises" || cmd === "noisemenu") {
        if (!voiceChannel) return msg.reply("Join a voice channel first.");

        if (!presetIndex.has(msg.guild.id)) presetIndex.set(msg.guild.id, 0);
        let index = presetIndex.get(msg.guild.id);

        const getEmbed = () => {
            const p = presets[index];
            return new EmbedBuilder()
                .setTitle("🔊 Noise Selector")
                .setDescription(`**${p.label}** — ${p.description}`)
                .addFields(
                    { name: "Type", value: p.type, inline: true },
                    { name: "Lowpass", value: `${p.lowpass} Hz`, inline: true },
                    { name: "Highpass", value: `${p.highpass} Hz`, inline: true },
                    { name: "Volume", value: `${p.volume}`, inline: true },
                )
                .setFooter({ text: "⬅️ / ➡️ to change — ▶️ to play" })
                .setColor("#00f7ff");
        };

        const menu = await msg.reply({ embeds: [getEmbed()] });
        await menu.react("⬅️");
        await menu.react("▶️");
        await menu.react("➡️");

        const filter = (reaction, user) =>
            ["⬅️", "➡️", "▶️"].includes(reaction.emoji.name) &&
            user.id === msg.author.id;

        const collector = menu.createReactionCollector({ filter, time: 120000 });

        collector.on("collect", (reaction, user) => {
            reaction.users.remove(user.id).catch(()=>{});
            if (reaction.emoji.name === "⬅️") index = (index - 1 + presets.length) % presets.length;
            if (reaction.emoji.name === "➡️") index = (index + 1) % presets.length;
            if (reaction.emoji.name === "▶️") {
                playFromPreset(presets[index], msg.guild.id, voiceChannel);
                msg.reply(`Now playing **${presets[index].label}**`).catch(()=>{});
            }
            presetIndex.set(msg.guild.id, index);
            menu.edit({ embeds: [ getEmbed() ] }).catch(()=>{});
        });

        return;
    }

    if (cmd === "play") {
        if (!voiceChannel) return msg.reply("Join a voice channel first.");
        const name = args.join(" ").toLowerCase();
        const preset = presets.find(p => p.id === name || p.label.toLowerCase() === name);
        if (!preset) return msg.reply("Preset not found. Try Snoises for a menu.");
        playFromPreset(preset, msg.guild.id, voiceChannel);
        return msg.reply(`Now playing **${preset.label}**`);
    }

    if (cmd === "remote") {
        if (!voiceChannel) return msg.reply("Join a voice channel first.");
        const s = getSettings(msg.guild.id);
        if (!s.preset) s.preset = "smooth-brown";
        const msgRef = await sendOrUpdateRemote(msg);
        return;
    }

    if (cmd === "stop") {
        const player = players.get(msg.guild.id);
        if (player) player.stop();
        killFfmpeg(msg.guild.id);
        return msg.reply("Stopped playback.");
    }

    if (cmd === "leave") {
        const conn = getVoiceConnection(msg.guild.id);
        if (conn) conn.destroy();
        killFfmpeg(msg.guild.id);
        return msg.reply("Left the voice channel.");
    }

});

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

    const id = interaction.customId; 

    const parts = id.split(":");
    if (parts.length < 3) return;

    const action = parts[0];
    const sub = parts[1];   
    const rawmagnitude = parts[2];  
    const guildId = parts[3] || parts[2]; 
    
    if (interaction.isStringSelectMenu()) {
        const cidParts = id.split(":");
        const kind = cidParts[1]; 
        const gid = cidParts[2];
        if (!interaction.values || interaction.values.length === 0) {
            await interaction.reply({ content: "No selection.", ephemeral: true }).catch(()=>{});
            return;
        }
        const value = interaction.values[0];

        if (kind === "preset") {
            const prefix = "preset:";
            if (!value.startsWith(prefix)) {
                await interaction.reply({ content: "Invalid preset value.", ephemeral: true }).catch(()=>{});
                return;
            }
            const presetId = value.substring(prefix.length);
            const preset = presets.find(p => p.id === presetId);
            if (!preset) {
                await interaction.reply({ content: "Preset not found.", ephemeral: true }).catch(()=>{});
                return;
            }
            const s = getSettings(gid);
            s.type = preset.type;
            s.lowpass = preset.lowpass;
            s.highpass = preset.highpass;
            s.volume = preset.volume;
            s.preset = preset.id;

            const member = interaction.guild?.members?.cache?.get(interaction.user.id);
            const voiceChannel = member?.voice?.channel;
            if (voiceChannel) playCurrent(gid, voiceChannel);

            const remote = remoteMessages.get(gid);
            if (remote) {
                const channelRef = await client.channels.fetch(remote.channelId).catch(()=>null);
                if (channelRef) {
                    const messageRef = await channelRef.messages.fetch(remote.messageId).catch(()=>null);
                    if (messageRef) {
                        await messageRef.edit({ embeds: [ buildRemoteEmbed(gid) ], components: buildRemoteComponents(gid) }).catch(()=>{});
                    }
                }
            }

            await interaction.reply({ content: `Applied preset **${preset.label}**`, ephemeral: true }).catch(()=>{});
            return;
        }

        if (kind === "type") {
            const gid = cidParts[2];
            const value = interaction.values[0]; 
            if (!value.startsWith("type:")) {
                await interaction.reply({ content: "Invalid type.", ephemeral: true }).catch(()=>{});
                return;
            }
            const newType = value.split(":")[1];
            const s = getSettings(gid);
            s.type = newType;
            s.preset = "custom";

            const member = interaction.guild?.members?.cache?.get(interaction.user.id);
            const voiceChannel = member?.voice?.channel;
            if (voiceChannel) playCurrent(gid, voiceChannel);

            const remote = remoteMessages.get(gid);
            if (remote) {
                const channelRef = await client.channels.fetch(remote.channelId).catch(()=>null);
                if (channelRef) {
                    const messageRef = await channelRef.messages.fetch(remote.messageId).catch(()=>null);
                    if (messageRef) {
                        await messageRef.edit({ embeds: [ buildRemoteEmbed(gid) ], components: buildRemoteComponents(gid) }).catch(()=>{});
                    }
                }
            }

            await interaction.reply({ content: `Noise type set to ${newType}`, ephemeral: true }).catch(()=>{});
            return;
        }
    }

    // BUTTONS ----------------------------------------------------------------
    const parts2 = id.split(":");

    if (parts2.length < 3) {
        await interaction.reply({ content: "Invalid control.", ephemeral: true }).catch(()=>{});
        return;
    }

    if (parts2[0] === "control") {
        const op = parts2[1];
        const gid = parts2[2];
        const member = interaction.guild?.members?.cache?.get(interaction.user.id);
        const voiceChannel = member?.voice?.channel;

        if (op === "play") {
            if (!voiceChannel) {
                await interaction.reply({ content: "Join a voice channel to play audio.", ephemeral: true }).catch(()=>{});
                return;
            }
            playCurrent(gid, voiceChannel);
            const remote = remoteMessages.get(gid);
            if (remote) {
                const channelRef = await client.channels.fetch(remote.channelId).catch(()=>null);
                if (channelRef) {
                    const messageRef = await channelRef.messages.fetch(remote.messageId).catch(()=>null);
                    if (messageRef) {
                        await messageRef.edit({ embeds: [ buildRemoteEmbed(gid) ], components: buildRemoteComponents(gid) }).catch(()=>{});
                    }
                }
            }
            await interaction.reply({ content: "Playing (settings applied).", ephemeral: true }).catch(()=>{});
            return;
        }

        if (op === "stop") {
            const player = players.get(gid);
            if (player) player.stop();
            killFfmpeg(gid);
            await interaction.reply({ content: "Stopped playback.", ephemeral: true }).catch(()=>{});
            return;
        }

        if (op === "leave") {
            const conn = getVoiceConnection(gid);
            if (conn) conn.destroy();
            killFfmpeg(gid);
            await interaction.reply({ content: "Left the voice channel.", ephemeral: true }).catch(()=>{});
            return;
        }
    }

    const param = parts2[0];
    const direction = parts2[1]; // inc / dec
    const magnitude = parts2[2]; // fine / coarse
    const gid = parts2[3];

    const s = getSettings(gid);

    // define step sizes (choice A = simple +/- buttons; choice C = both increments)
    let step = 0;
    if (param === "lowpass") {
        step = (magnitude === "fine") ? 100 : 500; // fine 100Hz, coarse 500Hz
        s.lowpass = clampFreq(s.lowpass + (direction === "inc" ? step : -step));
    } else if (param === "highpass") {
        step = (magnitude === "fine") ? 10 : 50; // fine 10Hz, coarse 50Hz
        s.highpass = clampFreq(s.highpass + (direction === "inc" ? step : -step));
    } else if (param === "volume") {
        const volStep = (magnitude === "fine") ? 0.02 : 0.10; // fine 0.02, coarse 0.10
        s.volume = clampVolume(s.volume + (direction === "inc" ? volStep : -volStep));
    } else {
        // unknown parameter
        await interaction.reply({ content: "Unknown parameter.", ephemeral: true }).catch(()=>{});
        return;
    }

    s.preset = "custom";

    const member = interaction.guild?.members?.cache?.get(interaction.user.id);
    const voiceChannel = member?.voice?.channel;
    if (voiceChannel) playCurrent(gid, voiceChannel);

    const remote = remoteMessages.get(gid);
    if (remote) {
        const channelRef = await client.channels.fetch(remote.channelId).catch(()=>null);
        if (channelRef) {
            const messageRef = await channelRef.messages.fetch(remote.messageId).catch(()=>null);
            if (messageRef) {
                await messageRef.edit({ embeds: [ buildRemoteEmbed(gid) ], components: buildRemoteComponents(gid) }).catch(()=>{});
            }
        }
    }

    await interaction.reply({ content: "Updated setting.", ephemeral: true }).catch(()=>{});
});

client.on("ready", () => {
    client.user.setPresence({
        activities: [{ name: "Shelp | Sremote" }],
        status: "online"
    });
});

client.login(process.env.DISCORD_BOT_TOKEN);
