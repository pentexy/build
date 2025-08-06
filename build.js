const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { load } = require('prismarine-nbt');
const { parse } = require('prismarine-nbt');
const { promisify } = require('util');
const nbt = require('prismarine-nbt');

const CONFIG = {
    host: 'unholy-engraved.ap.e4mc.link',
    port: 25565,
    username: 'BuilderBot',
    buildDelay: 100,
    maxRetries: 3,
    schematicUrl: 'https://files.catbox.moe/r7z2gh.nbt',
    schematicFile: 'house.nbt',
    safetyCheck: true,
    clearInventory: true
};

// Helper function to download schematic
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                return reject(new Error(`Failed to get '${url}' (${response.statusCode})`));
            }
            response.pipe(file);
            file.on('finish', () => file.close(resolve));
        }).on('error', (err) => {
            fs.unlink(dest, () => reject(err));
        });
    });
}

// Load schematic
async function loadSchematic(filePath) {
    const data = fs.readFileSync(filePath);
    const { parsed } = await nbt.parse(data);
    return parsed;
}

// Main bot
let bot;

async function startBot() {
    bot = mineflayer.createBot({
        host: CONFIG.host,
        port: CONFIG.port,
        username: CONFIG.username
    });

    bot.once('spawn', async () => {
        console.log('✅ Bot spawned in the world.');

        if (!fs.existsSync(CONFIG.schematicFile)) {
            console.log('⬇️ Downloading schematic...');
            await downloadFile(CONFIG.schematicUrl, CONFIG.schematicFile);
            console.log('✅ Schematic downloaded.');
        }

        const schematic = await loadSchematic(CONFIG.schematicFile);
        console.log('✅ Schematic loaded.');

        const size = schematic.value.size.value.value;
        const blocks = schematic.value.blocks.value;

        const origin = bot.entity.position.floored().offset(1, 0, 1);
        let completed = 0;
        let failed = 0;

        console.log(`🚧 Starting build at ${origin.x}, ${origin.y}, ${origin.z}`);
        const palette = schematic.value.palette.value.value;

        const blockMap = {};
        for (const [name, id] of Object.entries(palette)) {
            blockMap[id] = name;
        }

        const blockData = blocks.palette.value.value;
        const blockStates = blocks.block_states.value.value;

        for (let y = 0; y < size[1]; y++) {
            for (let z = 0; z < size[2]; z++) {
                for (let x = 0; x < size[0]; x++) {
                    const index = y * size[0] * size[2] + z * size[0] + x;
                    const state = blockStates[index];
                    const blockName = blockMap[state];

                    if (!blockName || blockName === 'minecraft:air') continue;

                    const position = origin.offset(x, y, z);
                    const block = bot.blockAt(position);

                    if (!block || block.name !== blockName.replace('minecraft:', '')) {
                        try {
                            await placeBlock(bot, position, blockName);
                            completed++;
                            process.stdout.write(`\r🧱 Placed: ${completed} | ❌ Failed: ${failed}`);
                            await sleep(CONFIG.buildDelay);
                        } catch (e) {
                            failed++;
                        }
                    }
                }
            }
        }

        console.log(`\n✅ Build completed. Total: ${completed}, Failed: ${failed}`);
        bot.chat("🏠 Build complete!");
    });

    bot.on('error', console.log);
    bot.on('end', () => {
        console.log("⚠️ Bot disconnected. Restarting...");
        setTimeout(startBot, 5000);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function placeBlock(bot, position, blockName) {
    return new Promise((resolve, reject) => {
        const reference = bot.blockAt(position.offset(0, -1, 0));
        if (!reference || !bot.canPlaceBlock(reference, new Vec3(0, 1, 0))) {
            return reject("Can't place block here.");
        }

        bot.placeBlock(reference, new Vec3(0, 1, 0), (err) => {
            if (err) return reject(err);
            resolve();
        });
    });
}

startBot();      log('Set build position first using !come x y z');
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
