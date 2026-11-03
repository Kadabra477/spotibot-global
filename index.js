require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
  getVoiceConnection,
} = require('@discordjs/voice');
const prism = require('prism-media');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const DATA_DIR = path.join(__dirname, 'data', 'users');

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ Faltan DISCORD_TOKEN o CLIENT_ID en las variables de entorno (.env).');
  process.exit(1);
}

// Crear carpeta persistente para credenciales de cada usuario
fs.mkdirSync(DATA_DIR, { recursive: true });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Sesiones activas por servidor: guildId -> { librespot, ffmpeg, player, ownerId }
const activeSessions = new Map();
// Sesiones temporales de login OAuth: userId -> { process, port, timeout }
const pendingLogins = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName('login')
    .setDescription('Vincula tu cuenta de Spotify con el bot'),
  new SlashCommandBuilder()
    .setName('logout')
    .setDescription('Desvincula y borra tus credenciales de Spotify del bot'),
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Conecta el bot a tu canal de voz para reproducir desde tu Spotify'),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Desconecta el bot del canal de voz'),
].map((cmd) => cmd.toJSON());

// Registrar comandos globales en Discord
const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Comandos globales (/login, /logout, /join, /leave) registrados.');
  } catch (err) {
    console.error('❌ Error registrando comandos:', err);
  }
})();

function getUserCacheDir(userId) {
  return path.join(DATA_DIR, userId);
}

function isUserLinked(userId) {
  return fs.existsSync(path.join(getUserCacheDir(userId), 'credentials.json'));
}

function stopGuildSession(guildId) {
  const session = activeSessions.get(guildId);
  if (session) {
    try {
      if (session.librespot && !session.librespot.killed) {
        session.librespot.kill('SIGTERM');
      }
      if (session.ffmpeg) session.ffmpeg.destroy();
      if (session.player) session.player.stop();
    } catch (e) {
      console.error(`Error cerrando sesión en servidor ${guildId}:`, e.message);
    }
    activeSessions.delete(guildId);
  }
  const connection = getVoiceConnection(guildId);
  if (connection) {
    try {
      connection.destroy();
    } catch (_) {}
  }
}

function cleanupPendingLogin(userId) {
  const pending = pendingLogins.get(userId);
  if (pending) {
    clearTimeout(pending.timeout);
    try {
      if (pending.process && !pending.process.killed) {
        pending.process.kill('SIGTERM');
      }
    } catch (_) {}
    pendingLogins.delete(userId);
  }
}

client.once('ready', () => {
  console.log(`🌐 Bot global conectado como ${client.user.tag}`);
});

// Desconectar automáticamente si el canal de voz queda vacío
client.on('voiceStateUpdate', (oldState) => {
  const guildId = oldState.guild.id;
  const connection = getVoiceConnection(guildId);
  if (!connection) return;

  const botChannelId = connection.joinConfig.channelId;
  const channel = oldState.guild.channels.cache.get(botChannelId);
  if (channel) {
    const humanMembers = channel.members.filter((m) => !m.user.bot);
    if (humanMembers.size === 0) {
      stopGuildSession(guildId);
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    // 1. COMANDOS SLASH
    if (interaction.isChatInputCommand()) {
      const { commandName, guildId, user } = interaction;

      // COMANDO /login
      if (commandName === 'login') {
        await interaction.deferReply({ ephemeral: true });
        cleanupPendingLogin(user.id);

        const userDir = getUserCacheDir(user.id);
        fs.mkdirSync(userDir, { recursive: true });

        const oauthPort = Math.floor(15000 + Math.random() * 40000);

        const authProc = spawn('librespot', [
          '--name', `Spoticord (${user.username})`,
          '--cache', userDir,
          '--enable-oauth',
          '--oauth-port', String(oauthPort),
        ]);

        authProc.on('error', (err) => {
          console.error('Error al iniciar librespot en /login:', err.message);
        });

        let urlSent = false;

        const handleOutput = async (data) => {
          const text = data.toString();
          const match = text.match(/https:\/\/accounts\.spotify\.com\/authorize\?[^\s]+/);

          if (match && !urlSent) {
            urlSent = true;
            const authUrl = match[0];

            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setLabel('1. Autorizar en Spotify')
                .setStyle(ButtonStyle.Link)
                .setURL(authUrl),
              new ButtonBuilder()
                .setCustomId(`open_modal_${oauthPort}`)
                .setLabel('2. Pegar URL de confirmación')
                .setStyle(ButtonStyle.Primary)
            );

            await interaction.editReply({
              content:
                '### 🔗 Vincular tu cuenta de Spotify\n' +
                '1. Haz clic en **1. Autorizar en Spotify** e inicia sesión.\n' +
                '2. Al aceptar, el navegador te llevará a una página que dirá *"No se puede acceder a este sitio"* (`http://127.0.0.1:...`). **Eso es normal.**\n' +
                '3. Copia toda la dirección URL de la barra de tu navegador, vuelve a Discord y pulsa **2. Pegar URL de confirmación**.',
              components: [row],
            });
          }
        };

        authProc.stdout.on('data', handleOutput);
        authProc.stderr.on('data', handleOutput);

        const timeout = setTimeout(() => cleanupPendingLogin(user.id), 5 * 60 * 1000);
        pendingLogins.set(user.id, { process: authProc, port: oauthPort, timeout });
      }

      // COMANDO /logout
      if (commandName === 'logout') {
        const userDir = getUserCacheDir(user.id);
        if (fs.existsSync(userDir)) {
          fs.rmSync(userDir, { recursive: true, force: true });
        }
        return interaction.reply({
          content: '🗑️ Tus credenciales de Spotify fueron eliminadas del bot.',
          ephemeral: true,
        });
      }

      // COMANDO /join
      if (commandName === 'join') {
        if (!isUserLinked(user.id)) {
          return interaction.reply({
            content: '❌ Primero debes vincular tu Spotify usando `/login`.',
            ephemeral: true,
          });
        }

        const voiceChannel = interaction.member?.voice?.channel;
        if (!voiceChannel) {
          return interaction.reply({
            content: '❌ Entra primero a un canal de voz y vuelve a ejecutar `/join`.',
            ephemeral: true,
          });
        }

        await interaction.deferReply();
        stopGuildSession(guildId);

        const deviceName = `Spoticord (${user.username})`;
        const userDir = getUserCacheDir(user.id);

        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: guildId,
          adapterCreator: interaction.guild.voiceAdapterCreator,
          selfDeaf: true,
          selfMute: false,
        });

        const librespot = spawn('librespot', [
          '--name', deviceName,
          '--backend', 'pipe',
          '--bitrate', '320',
          '--cache', userDir,
          '--disable-audio-cache',
          '--initial-volume', '100',
        ]);

        librespot.on('error', (err) => {
          console.error(`Error en librespot (servidor ${guildId}):`, err.message);
        });

        const ffmpeg = new prism.FFmpeg({
          args: [
            '-analyzeduration', '0',
            '-loglevel', '0',
            '-f', 's16le',
            '-ar', '44100',
            '-ac', '2',
            '-i', 'pipe:0',
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
          ],
        });

        ffmpeg.on('error', (err) => {
          console.error(`Error en FFmpeg (servidor ${guildId}):`, err.message);
        });

        const audioStream = librespot.stdout.pipe(ffmpeg);
        const resource = createAudioResource(audioStream, {
          inputType: StreamType.Raw,
        });

        const player = createAudioPlayer({
          behaviors: {
            noSubscriber: NoSubscriberBehavior.Play,
            maxMissedFrames: Infinity,
          },
        });

        player.on('error', (err) => {
          console.error(`Error en reproductor (servidor ${guildId}):`, err.message);
        });

        player.play(resource);
        connection.subscribe(player);

        activeSessions.set(guildId, {
          librespot,
          ffmpeg,
          player,
          ownerId: user.id,
        });

        await interaction.editReply(
          `🟢 Conectado a **${voiceChannel.name}**.\n` +
          `🎧 <@${user.id}>, abre tu Spotify, toca **Conectar a un dispositivo** y elige **${deviceName}**.`
        );
      }

      // COMANDO /leave
      if (commandName === 'leave') {
        stopGuildSession(guildId);
        await interaction.reply('👋 Desconectado del canal de voz.');
      }
    }

    // 2. BOTÓN PARA ABRIR EL MODAL DE CONFIRMACIÓN
    if (interaction.isButton() && interaction.customId.startsWith('open_modal_')) {
      const modal = new ModalBuilder()
        .setCustomId('spotify_callback_modal')
        .setTitle('Confirmar vinculación de Spotify');

      const urlInput = new TextInputBuilder()
        .setCustomId('callback_url')
        .setLabel('Pega la URL http://127.0.0.1... aquí')
        .setPlaceholder('http://127.0.0.1:xxxxx/login?code=...')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(urlInput));
      await interaction.showModal(modal);
    }

    // 3. RECIBIR LA URL DEL MODAL Y COMPLETAR EL LOGIN
    if (interaction.isModalSubmit() && interaction.customId === 'spotify_callback_modal') {
      await interaction.deferReply({ ephemeral: true });
      const userId = interaction.user.id;
      const pending = pendingLogins.get(userId);

      if (!pending) {
        return interaction.editReply('❌ Tu sesión de login expiró. Ejecuta `/login` otra vez.');
      }

      const rawUrl = interaction.fields.getTextInputValue('callback_url').trim();
      if (!rawUrl.startsWith(`http://127.0.0.1:${pending.port}/login`)) {
        return interaction.editReply(
          '❌ La URL no coincide con la sesión actual. Asegúrate de copiar toda la dirección que empieza con `http://127.0.0.1`.'
        );
      }

      try {
        await fetch(rawUrl);
        await new Promise((r) => setTimeout(r, 1500));
        cleanupPendingLogin(userId);

        if (isUserLinked(userId)) {
          await interaction.editReply(
            '✅ **¡Tu Spotify quedó vinculado!** Ahora entra a un canal de voz y usa `/join`.'
          );
        } else {
          await interaction.editReply(
            '⚠️ No se pudo guardar la sesión. Verifica que tu cuenta sea Spotify Premium e intenta con `/login` de nuevo.'
          );
        }
      } catch (err) {
        cleanupPendingLogin(userId);
        await interaction.editReply('❌ Error al validar el código. Ejecuta `/login` nuevamente.');
      }
    }
  } catch (err) {
    console.error('Error en interacción:', err);
  }
});

client.login(TOKEN);