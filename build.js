const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear, GoalBlock } = goals;
const { Vec3 } = require('vec3');
const nbt = require('prismarine-nbt');
const fs = require('fs');
const mcDataLoader = require('minecraft-data');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

// For Node.js <18
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Configuration
const CONFIG = {
    host: 'dares-directory.ap.e4mc.link',
    port: 25565,
    username: 'BuilderBot',
    buildDelay: 100, // Delay between placing blocks
    maxRetries: 3,
    schematicUrl: 'https://files.catbox.moe/r7z2gh.nbt', // URL to your schematic
    schematicFile: 'house.nbt',{// Local file name for schematic
    safetyCheck: true, // Not fully implemented, but good to have
    clearInventory: false, // Not fully implemented
    requestItems: true, // Not fully implemented
    layerHeight: 2, // How many layers to build at a time before returning to chest
    scaffoldingBlock: 'dirt' // Block to use for scaffolding
};

const bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username
});

bot.loadPlugin(pathfinder);

const state = {
    chestPos: null, // Position of the chest
    buildPos: null, // Starting position for the build
    structure: null, // Loaded schematic data
    requiredItems: {}, // All items needed for the entire schematic
    inventoryItems: {}, // Current items in bot's inventory
    isBuilding: false, // Flag to indicate if building is in progress
    isCollecting: false, // Flag to indicate if collecting is in progress
    missingItems: {}, // Items currently missing for the build
    scaffoldingBlocks: [] // Keep track of placed scaffolding blocks
};

// Helper functions
const log = (message) => {
    console.log(`[${new Date().toISOString()}] ${message}`);
    if (bot && bot.chat) bot.chat(message);
};

// Extracts the block name from a prismarine-nbt block state
const getBlockName = (blockState) => {
    // Example: { Name: { type: 'string', value: 'minecraft:stone' } }
    return blockState.Name.value.split(':')[1] || blockState.Name.value;
};

// Scans the bot's inventory and updates the state.inventoryItems
const scanInventory = () => {
    state.inventoryItems = {};
    bot.inventory.items().forEach(item => {
        state.inventoryItems[item.name] = (state.inventoryItems[item.name] || 0) + item.count;
    });
};

// Moves the bot to a specific position within a given distance
const goToPosition = async (position, distance = 1) => {
    const mcData = mcDataLoader(bot.version);
    const movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new GoalNear(position.x, position.y, position.z, distance));
    
    // Wait until the bot is close enough to the target position
    await new Promise((resolve) => {
        const checkArrival = setInterval(() => {
            if (bot.entity.position.distanceTo(position) <= distance + 0.5) {
                clearInterval(checkArrival);
                resolve();
            }
        }, 500);
    });
};

// Makes the bot look at a specific block position
const faceBlock = async (position) => {
    await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
};

// Downloads the schematic from the configured URL and parses it
const downloadSchematic = async () => {
    try {
        log('Downloading schematic...');
        const res = await fetch(CONFIG.schematicUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const buffer = await res.buffer();
        fs.writeFileSync(CONFIG.schematicFile, buffer); // Save locally
        
        const data = await nbt.parse(buffer);
        state.structure = data.parsed.value;

        // Calculate all required items for the entire schematic
        state.requiredItems = {};
        state.structure.blocks.value.value.forEach(block => {
            const blockState = state.structure.palette.value.value[block.state.value];
            const name = getBlockName(blockState);
            state.requiredItems[name] = (state.requiredItems[name] || 0) + 1;
        });

        log('Schematic loaded ✅');
    } catch (err) {
        log(`Failed to load schematic: ${err.message}`);
    }
};

// Manages inventory by depositing unneeded items and withdrawing required ones
const manageInventory = async (chestPosition, itemsToWithdraw) => {
    if (!chestPosition) {
        log('Chest position not set. Cannot manage inventory.');
        return false;
    }
    
    try {
        await goToPosition(chestPosition);
        const chestBlock = bot.blockAt(chestPosition);
        if (!chestBlock) {
            throw new Error('Chest not found at specified position.');
        }
        
        await faceBlock(chestBlock.position); // Face the chest before opening
        const chest = await bot.openChest(chestBlock);
        
        log('Managing inventory...');

        // 1. Deposit all non-building items (items not in state.requiredItems)
        for (const item of bot.inventory.items()) {
            // Only deposit if it's not a required item for the entire build
            if (!state.requiredItems[item.name] && item.name !== CONFIG.scaffoldingBlock) {
                try {
                    await chest.deposit(item.type, null, item.count);
                    log(`Deposited ${item.count}x ${item.name} to chest.`);
                    await sleep(100); // Small delay to prevent rate limiting
                } catch (err) {
                    log(`Failed to deposit ${item.name}: ${err.message}`);
                }
            }
        }
        
        // 2. Withdraw needed items for the current building phase
        scanInventory(); // Rescan inventory after depositing
        for (const [name, needed] of Object.entries(itemsToWithdraw)) {
            const have = state.inventoryItems[name] || 0;
            if (have < needed) {
                const itemsInChest = chest.items().filter(i => i.name === name);
                if (itemsInChest.length > 0) {
                    const toTake = Math.min(needed - have, itemsInChest[0].count);
                    await chest.withdraw(itemsInChest[0].type, null, toTake);
                    log(`Withdrew ${toTake}x ${name} from chest.`);
                    await sleep(100); // Small delay
                } else {
                    log(`Warning: ${name} not found in chest for withdrawal.`);
                }
            }
        }
        
        await chest.close();
        log('Inventory management complete.');
        return true;
    } catch (err) {
        log(`Chest interaction error: ${err.message}`);
        return false;
    }
};

// Collects nearby dropped items that are needed for the build
const collectNearbyItems = async () => {
    if (state.isBuilding) return; // Don't collect if building
    state.isCollecting = true;
    log('Scanning for nearby items to collect...');
    const items = Object.values(bot.entities).filter(e => e.type === 'item');
    let collectedCount = 0;
    for (const item of items) {
        const itemName = item.name || (item.metadata[item.metadata.length - 1] && item.metadata[item.metadata.length - 1].nbt && item.metadata[item.metadata.length - 1].nbt.value.item && item.metadata[item.metadata.length - 1].nbt.value.item.value.id.value.split(':')[1]);
        if (itemName && state.requiredItems[itemName]) {
            log(`Going to collect ${itemName} at ${item.position.x}, ${item.position.y}, ${item.position.z}`);
            await goToPosition(item.position, 2); // Go close to the item
            await sleep(500); // Wait for item collection animation
            collectedCount++;
        }
    }
    if (collectedCount > 0) {
        log(`Collected ${collectedCount} nearby items.`);
    } else {
        log('No relevant items found nearby.');
    }
    state.isCollecting = false;
};

// Calculates items needed for a specific range of Y-coordinates (layers)
const calculateItemsForLayers = (minY, maxY) => {
    const items = {};
    if (!state.structure) return items;

    state.structure.blocks.value.value.forEach(block => {
        const blockY = block.pos.value[1];
        if (blockY >= minY && blockY < maxY) {
            const blockState = state.structure.palette.value.value[block.state.value];
            const name = getBlockName(blockState);
            items[name] = (items[name] || 0) + 1;
        }
    });
    return items;
};

// Places scaffolding blocks to reach higher positions
const placeScaffolding = async (targetPos) => {
    const botY = bot.entity.position.y;
    const targetBlockY = targetPos.y;
    const diffY = targetBlockY - botY;

    // If the target block is more than 2 blocks above the bot, or if it's too far horizontally
    if (diffY > 1.5 || bot.entity.position.distanceTo(targetPos) > 4) {
        log(`Placing scaffolding to reach ${targetPos.x}, ${targetPos.y}, ${targetPos.z}`);
        
        const scaffoldingItem = bot.inventory.items().find(i => i.name === CONFIG.scaffoldingBlock);
        if (!scaffoldingItem) {
            log(`Error: No ${CONFIG.scaffoldingBlock} in inventory for scaffolding!`);
            return false;
        }

        // Determine a good scaffolding position (e.g., directly below or next to target)
        let scaffoldPlacePos = new Vec3(targetPos.x, botY, targetPos.z);
        let referenceBlock = bot.blockAt(scaffoldPlacePos.offset(0, -1, 0));

        // Find a suitable spot to place scaffolding
        let currentScaffoldY = botY -1;
        while (currentScaffoldY < targetBlockY - 1) { // Build up to one block below target
            let placePos = new Vec3(targetPos.x, currentScaffoldY, targetPos.z);
            let blockAtPos = bot.blockAt(placePos);

            if (blockAtPos.name === 'air') {
                try {
                    await goToPosition(placePos.offset(0, -1, 0), 2); // Go near the base of the scaffold
                    await bot.equip(scaffoldingItem, 'hand');
                    const supportBlock = bot.blockAt(placePos.offset(0, -1, 0));
                    if (!supportBlock || supportBlock.name === 'air') {
                        // If no support below, try to place next to current bot position
                        const tempSupportPos = bot.entity.position.offset(0, -1, 0);
                        const tempSupportBlock = bot.blockAt(tempSupportPos);
                        if (tempSupportBlock && tempSupportBlock.name !== 'air') {
                            await bot.placeBlock(tempSupportBlock, new Vec3(0, 1, 0));
                            state.scaffoldingBlocks.push(tempSupportPos.offset(0, 1, 0));
                            await sleep(CONFIG.buildDelay);
                        } else {
                            log('Cannot find a suitable support for scaffolding.');
                            return false;
                        }
                    } else {
                        await bot.placeBlock(supportBlock, new Vec3(0, 1, 0));
                        state.scaffoldingBlocks.push(placePos);
                        await sleep(CONFIG.buildDelay);
                    }
                    currentScaffoldY++;
                } catch (err) {
                    log(`Failed to place scaffolding at ${placePos}: ${err.message}`);
                    return false;
                }
            } else {
                currentScaffoldY++; // Block already exists, move up
            }
        }
        return true;
    }
    return true; // No scaffolding needed
};

// Removes placed scaffolding blocks
const removeScaffolding = async () => {
    if (state.scaffoldingBlocks.length === 0) return;

    log('Removing scaffolding...');
    // Remove in reverse order (top to bottom)
    for (let i = state.scaffoldingBlocks.length - 1; i >= 0; i--) {
        const pos = state.scaffoldingBlocks[i];
        const block = bot.blockAt(pos);
        if (block && block.name === CONFIG.scaffoldingBlock) {
            try {
                await goToPosition(pos, 2); // Go near the scaffolding block
                await bot.dig(block);
                log(`Removed scaffolding at ${pos}`);
                await sleep(CONFIG.buildDelay);
            } catch (err) {
                log(`Failed to remove scaffolding at ${pos}: ${err.message}`);
            }
        }
    }
    state.scaffoldingBlocks = []; // Clear the list
};

// Main building function, now handles layering and scaffolding
const buildStructure = async () => {
    if (state.isBuilding) {
        log('Already building!');
        return;
    }
    state.isBuilding = true;

    try {
        if (!state.buildPos || !state.structure) {
            throw new Error('Set build position and load schematic first.');
        }

        log('Starting layered building process...');

        const blocks = state.structure.blocks.value.value;
        const palette = state.structure.palette.value.value;

        // Sort blocks by Y-coordinate to build from bottom up
        blocks.sort((a, b) => a.pos.value[1] - b.pos.value[1]);

        const minSchematicY = blocks[0].pos.value[1];
        const maxSchematicY = blocks[blocks.length - 1].pos.value[1];

        for (let currentLayerY = minSchematicY; currentLayerY <= maxSchematicY; currentLayerY += CONFIG.layerHeight) {
            if (!state.isBuilding) {
                log('Building stopped by command.');
                break;
            }

            const nextLayerY = currentLayerY + CONFIG.layerHeight;
            log(`Preparing for layers Y: ${currentLayerY} to ${nextLayerY - 1}`);

            // Calculate items needed for the current set of layers
            const itemsForCurrentLayers = calculateItemsForLayers(currentLayerY, nextLayerY);
            
            // Go to chest and manage inventory for these layers
            const inventoryReady = await manageInventory(state.chestPos, itemsForCurrentLayers);
            if (!inventoryReady) {
                log('Failed to get required items for current layers. Retrying...');
                // Optionally add retry logic or wait for user to provide items
                await sleep(5000); // Wait 5 seconds before next attempt
                continue;
            }
            scanInventory(); // Rescan after inventory management

            // Filter blocks for the current layers
            const blocksInCurrentLayers = blocks.filter(block =>
                block.pos.value[1] >= currentLayerY && block.pos.value[1] < nextLayerY
            );

            for (const block of blocksInCurrentLayers) {
                if (!state.isBuilding) break;

                const blockState = palette[block.state.value];
                const blockName = getBlockName(blockState);
                const position = new Vec3(
                    block.pos.value[0] + state.buildPos.x,
                    block.pos.value[1] + state.buildPos.y,
                    block.pos.value[2] + state.buildPos.z
                );

                // Check if the block already exists and is correct
                const existingBlock = bot.blockAt(position);
                if (existingBlock && existingBlock.name === blockName) {
                    // log(`Block ${blockName} at ${position} already exists.`);
                    continue; // Skip if already placed
                }
                
                // Ensure bot has the item
                const item = bot.inventory.items().find(i => i.name === blockName);
                if (!item) {
                    log(`Out of ${blockName} for ${position}. Returning to chest.`);
                    // This means we ran out mid-layer. Break and restart layer process.
                    break;
                }

                // Go to position and place scaffolding if needed
                await goToPosition(position, 4); // Go generally near the target
                const scaffoldingNeeded = await placeScaffolding(position);
                if (!scaffoldingNeeded) {
                    log(`Could not place scaffolding for ${position}. Skipping block.`);
                    continue;
                }

                try {
                    await bot.equip(item, 'hand');
                    
                    // Find a reference block to place on
                    let referenceBlock = bot.blockAt(position.offset(0, -1, 0)); // Try directly below
                    if (!referenceBlock || referenceBlock.name === 'air') {
                        // If no block directly below, try adjacent blocks on the same Y-level
                        const potentialReferences = [
                            position.offset(1, 0, 0), position.offset(-1, 0, 0),
                            position.offset(0, 0, 1), position.offset(0, 0, -1)
                        ];
                        for (const refPos of potentialReferences) {
                            const b = bot.blockAt(refPos);
                            if (b && b.name !== 'air') {
                                referenceBlock = b;
                                break;
                            }
                        }
                    }

                    if (!referenceBlock || referenceBlock.name === 'air') {
                        log(`No suitable reference block found for ${blockName} at ${position}. Skipping.`);
                        continue;
                    }

                    // Calculate face to place on (usually top of reference block)
                    const faceVector = position.minus(referenceBlock.position);

                    await bot.placeBlock(referenceBlock, faceVector);
                    log(`Placed ${blockName} at ${position.x}, ${position.y}, ${position.z}`);
                    await sleep(CONFIG.buildDelay);
                } catch (err) {
                    log(`Building error at ${position}: ${err.message}`);
                    // Consider retrying or skipping this block
                } finally {
                    // Always try to remove scaffolding after placing the block
                    await removeScaffolding();
                }
            }
        }

        log('Build complete ✅');
    } catch (err) {
        log(`Build failed: ${err.message}`);
    } finally {
        state.isBuilding = false;
        await removeScaffolding(); // Ensure all scaffolding is removed at the end
    }
};

// Event handlers
bot.once('spawn', async () => {
    log('Bot spawned!');
    await downloadSchematic();
});

const handleCommand = async (username, message) => {
    if (username === bot.username) return; // Ignore bot's own messages

    const args = message.trim().split(' ');
    const cmd = args[0].toLowerCase();

    try {
        switch (cmd) {
            case '!setchest':
                if (args.length === 4) {
                    state.chestPos = new Vec3(+args[1], +args[2], +args[3]);
                    log(`Chest position set to ${state.chestPos.x}, ${state.chestPos.y}, ${state.chestPos.z}`);
                } else {
                    log('Usage: !setchest <x> <y> <z>');
                }
                break;

            case '!come':
                if (args.length === 4) {
                    state.buildPos = new Vec3(+args[1], +args[2], +args[3]);
                    log(`Build position set to ${state.buildPos.x}, ${state.buildPos.y}, ${state.buildPos.z}. Going there now.`);
                    await goToPosition(state.buildPos);
                } else {
                    log('Usage: !come <x> <y> <z>');
                }
                break;

            case '!build':
                if (!state.buildPos) {
                    log('Please set the build position first using !come <x> <y> <z>.');
                    return;
                }
                if (!state.chestPos) {
                    log('Please set the chest position first using !setchest <x> <y> <z>.');
                    return;
                }
                if (!state.structure) {
                    log('Schematic not loaded. Please wait or check schematic URL.');
                    return;
                }
                await buildStructure();
                break;

            case '!materials':
                // This command can now trigger a full inventory check and request
                log('Checking materials and managing inventory...');
                const allRequired = calculateItemsForLayers(0, state.structure.size.value[1]); // Get all items
                await manageInventory(state.chestPos, allRequired);
                scanInventory();
                state.missingItems = {};
                for (const [name, needed] of Object.entries(allRequired)) {
                    const have = state.inventoryItems[name] || 0;
                    if (have < needed) {
                        state.missingItems[name] = needed - have;
                    }
                }
                if (Object.keys(state.missingItems).length > 0) {
                    log('Still missing items (use /give @s <item> <amount>):');
                    for (const [item, amount] of Object.entries(state.missingItems)) {
                        log(`/give @s ${item} ${amount}`);
                    }
                } else {
                    log('All required materials are in inventory or chest!');
                }
                break;

            case '!collect':
                await collectNearbyItems();
                break;

            case '!stop':
                state.isBuilding = false;
                log('Stopped current action. Finishing current block placement/removal.');
                break;

            case '!help':
                log('Commands: !setchest x y z, !come x y z, !build, !materials, !collect, !stop, !help');
                break;

            default:
                log(`Unknown command: ${cmd}. Type !help for commands.`);
                break;
        }
    } catch (err) {
        log(`Command execution error: ${err.message}`);
    }
};

bot.on('chat', (username, message) => {
    handleCommand(username, message).catch(err => {
        log(`Error handling command: ${err.message}`);
    });
});

bot.on('error', err => log(`Bot error: ${err.message}`));
bot.on('kicked', reason => log(`Bot kicked: ${reason}`));
bot.on('end', reason => log(`Bot disconnected: ${reason}`));

// Collect nearby items periodically (when not building or already collecting)
setInterval(async () => {
    if (!state.isBuilding && !state.isCollecting) {
        await collectNearbyItems();
    }
}, 30000); // Every 30 seconds
