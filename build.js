// Layered structure builder bot

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;
const { Vec3 } = require('vec3');
const nbt = require('prismarine-nbt');
const fs = require('fs');
const mcDataLoader = require('minecraft-data');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

// For Node.js < 18
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Configuration
const CONFIG = {
  host: 'unholy-engraved.ap.e4mc.link',
  port: 25565,
  username: 'BuilderBot',
  buildDelay: 100,
  schematicUrl: 'https://files.catbox.moe/r7z2gh.nbt',
  schematicFile: 'house.nbt'
};

// Create the bot
const bot = mineflayer.createBot({
  host: CONFIG.host,
  port: CONFIG.port,
  username: CONFIG.username
});

bot.loadPlugin(pathfinder);

let structure, palette, layers = [], buildPos = null;

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const getBlockName = (state) => state.Name.value.split(':')[1];

// Group blocks by Y layer
const groupBlocksByLayer = (blocks) => {
  const grouped = {};
  for (const block of blocks) {
    const y = block.pos.value[1];
    if (!grouped[y]) grouped[y] = [];
    grouped[y].push(block);
  }
  return Object.entries(grouped)
    .sort((a, b) => a[0] - b[0])
    .map(([_, v]) => v);
};

// Download and parse schematic file
const downloadAndParseSchematic = async () => {
  const res = await fetch(CONFIG.schematicUrl);
  const buffer = await res.buffer();
  fs.writeFileSync(CONFIG.schematicFile, buffer);
  const data = await nbt.parse(buffer);
  structure = data.parsed.value;
  palette = structure.palette.value.value;
  layers = groupBlocksByLayer(structure.blocks.value.value);
  log(`Schematic downloaded and parsed (${layers.length} layers)`);
};

// Move the bot to the given position
const goTo = async (pos) => {
  const mcData = mcDataLoader(bot.version);
  bot.pathfinder.setMovements(new Movements(bot, mcData));
  bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, 1));
  await new Promise((res) => {
    const int = setInterval(() => {
      if (bot.entity.position.distanceTo(pos) < 2) {
        clearInterval(int);
        res();
      }
    }, 500);
  });
};

// Scan bot's inventory
const scanInventory = () => {
  const result = {};
  for (const item of bot.inventory.items()) {
    result[item.name] = (result[item.name] || 0) + item.count;
  }
  return result;
};

// Build a single layer
const buildLayer = async (layerIndex) => {
  const layer = layers[layerIndex];
  log(`Starting layer ${layerIndex + 1}/${layers.length}`);
  const inventory = scanInventory();

  for (const block of layer) {
    const state = palette[block.state.value];
    const name = getBlockName(state);
    const item = bot.inventory.items().find(i => i.name === name);
    const pos = new Vec3(
      block.pos.value[0] + buildPos.x,
      block.pos.value[1] + buildPos.y,
      block.pos.value[2] + buildPos.z
    );

    if (!item) {
      log(`Missing ${name}, skipping block`);
      continue;
    }

    try {
      await bot.equip(item, 'hand');
      const reference = bot.blockAt(pos.offset(0, -1, 0));
      if (!reference || reference.name === 'air') {
        continue; // No support
      }
      await bot.placeBlock(reference, new Vec3(0, 1, 0));
      await sleep(CONFIG.buildDelay);
    } catch (err) {
      log(`Failed to place ${name} at ${pos}: ${err.message}`);
    }
  }
};

// Bot ready
bot.once('spawn', async () => {
  log('Bot spawned. Downloading schematic...');
  await downloadAndParseSchematic();
});

// Chat commands
bot.on('chat', async (username, message) => {
  if (username === bot.username) return;
  const args = message.trim().split(' ');

  if (args[0] === '!come' && args.length === 4) {
    buildPos = new Vec3(+args[1], +args[2], +args[3]);
    await goTo(buildPos);
    log(`Build position set to ${buildPos}`);
  }

  if (args[0] === '!build') {
    if (!buildPos) {
      log('Set build position first using !come x y z');
      return;
    }

    for (let i = 0; i < layers.length; i++) {
      await buildLayer(i);
      log(`Finished layer ${i + 1}`);
    }

    log('All layers built ✅');
  }
});
const collectLayerItems = async () => {
    state.isCollecting = true;
    
    // 1. Get items from chest first
    if (state.chestPos) {
        await goToPosition(state.chestPos);
        const chest = await bot.openChest(bot.blockAt(state.chestPos));
        
        for (const item of chest.items()) {
            if (isNeededForCurrentLayer(item.name)) {
                const toWithdraw = Math.min(item.count, CONFIG.layers.maxLayerItems);
                await chest.withdraw(item.type, null, toWithdraw);
            }
        }
        await chest.close();
    }
    
    // 2. Collect nearby floating items
    const items = Object.values(bot.entities).filter(e => 
        e.type === 'item' && isNeededForCurrentLayer(e.name)
    );
    
    for (const item of items) {
        await goToPosition(item.position, 2);
        await sleep(500); // Wait for collection
    }
    
    state.isCollecting = false;
};

const buildCurrentLayer = async () => {
    if (!state.structure || !state.buildPos) return;
    
    state.isBuilding = true;
    const blocks = state.structure.blocks.value.value;
    const palette = state.structure.palette.value.value;
    
    // Filter blocks for current layer
    const layerBlocks = blocks.filter(block => 
        Math.floor(block.pos.value[1]) === state.currentLayer
    );
    
    for (const block of layerBlocks) {
        if (!state.isBuilding) break;
        
        const blockState = palette[block.state.value];
        const blockName = getBlockName(blockState);
        const position = new Vec3(
            block.pos.value[0] + state.buildPos.x,
            block.pos.value[1] + state.buildPos.y,
            block.pos.value[2] + state.buildPos.z
        );
        
        try {
            const item = bot.inventory.items().find(i => i.name === blockName);
            if (!item) {
                log(`Missing ${blockName}, collecting more...`);
                await collectLayerItems();
                continue;
            }
            
            await bot.equip(item, 'hand');
            await bot.placeBlock(bot.blockAt(position), new Vec3(0, 1, 0));
            await sleep(CONFIG.buildDelay);
        } catch (err) {
            log(`Building error: ${err.message}`);
        }
    }
    
    if (state.isBuilding) {
        log(`Layer ${state.currentLayer} complete!`);
        state.currentLayer++;
    }
    state.isBuilding = false;
};

// Event handlers
bot.once('spawn', async () => {
    log('Bot ready!');
    await downloadSchematic();
});

bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    
    const args = message.trim().split(' ');
    const cmd = args[0].toLowerCase();
    
    try {
        switch (cmd) {
            case '!setchest':
                if (args.length === 4) {
                    state.chestPos = new Vec3(+args[1], +args[2], +args[3]);
                    log(`Chest location set`);
                }
                break;
                
            case '!come':
                if (args.length === 4) {
                    state.buildPos = new Vec3(+args[1], +args[2], +args[3]);
                    await goToPosition(state.buildPos);
                }
                break;
                
            case '!build':
                if (!state.isBuilding) {
                    state.currentLayer = 0;
                    await buildCurrentLayer();
                }
                break;
                
            case '!nextlayer':
                if (!state.isBuilding) {
                    await buildCurrentLayer();
                }
                break;
                
            case '!stop':
                state.isBuilding = false;
                log('Stopped building');
                break;
        }
    } catch (err) {
        log(`Error: ${err.message}`);
    }
});

// Auto-collect nearby items periodically
setInterval(async () => {
    if (!state.isBuilding && !state.isCollecting) {
        await collectLayerItems();
    }
}, 15000);

// Error handling
bot.on('error', err => log(`Bot error: ${err.message}`));
bot.on('kicked', reason => log(`Kicked: ${reason}`));
bot.on('end', reason => log(`Disconnected: ${reason}`));

// For Node.js <18 fetch compatibility
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
