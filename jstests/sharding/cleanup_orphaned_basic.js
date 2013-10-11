//
// Basic tests of cleanupOrphaned.
//

load('./jstests/libs/chunk_manipulation_util.js');
load('./jstests/libs/cleanup_orphaned_util.js');

/*****************************************************************************
 * Unsharded mongod.
 ****************************************************************************/

// cleanupOrphaned succeeds against unsharded mongod.
var mongod = startMongodTest();
assert.commandWorked(
    mongod.getDB('admin').runCommand({cleanupOrphaned: 'foo.bar'}));

/*****************************************************************************
 * Bad invocations of cleanupOrphaned command.
 ****************************************************************************/

var st = new ShardingTest({
    other: {
        rs: true,
        rsOptions: {nodes: 2}
    }
});

st.stopBalancer();

var mongos = st.s0;
var mongosAdmin = mongos.getDB('admin');
var dbName = 'foo';
var collectionName = 'bar';
var ns = dbName + '.' + collectionName;
var coll = mongos.getCollection(ns);

// cleanupOrphaned fails against mongos ('no such command'): it must be run
// on mongod.
assert.commandFailed(mongosAdmin.runCommand({cleanupOrphaned: ns}));

// cleanupOrphaned must be run on admin DB.
var shardFooDB = st.shard0.getDB(dbName);
assert.commandFailed(shardFooDB.runCommand({cleanupOrphaned: ns}));

// Must be run on primary.
var secondaryAdmin = st.rs0.getSecondary().getDB('admin');
var response = secondaryAdmin.runCommand({cleanupOrphaned: ns});
print('cleanupOrphaned on secondary:');
printjson(response);
assert.commandFailed(response);

// Bad ns.
// TODO: re-enable?
var shardAdmin = st.shard0.getDB('admin');
//var badNS = ' \\/."*<>:|?';
//response = shardAdmin.runCommand({cleanupOrphaned: badNS});
//print('cleanupOrphaned on bad NS:');
//printjson(response);
//assert.commandFailed(response);

/*****************************************************************************
 * Unsharded namespaces.
 ****************************************************************************/

// cleanupOrphaned succeeds on unsharded database.
assert.commandWorked(shardAdmin.runCommand({cleanupOrphaned: ns}));

// cleanupOrphaned succeeds on unsharded collection.
assert.commandWorked(mongosAdmin.runCommand({
    enableSharding: coll.getDB().getName()
}));

assert.commandWorked(shardAdmin.runCommand({cleanupOrphaned: ns}));

/*****************************************************************************
 * Bad startingFromKeys.
 ****************************************************************************/

// cleanupOrphaned fails if startingFrom doesn't match shard key pattern.
assert.commandWorked(mongosAdmin.runCommand({
    shardCollection: ns,
    key: {_id: 1}
}));

// Doesn't match number of keys.
assert.commandFailed(shardAdmin.runCommand({
    cleanupOrphaned: ns,
    startingFromKey: {someKey: 'someValue', someOtherKey: 1}
}));

// Matches number of keys but not key name.
// TODO: re-enable after SERVER-11104
//assert.commandFailed(shardAdmin.runCommand({
//    cleanupOrphaned: ns,
//    startingFromKey: {someKey: 'someValue'}
//}));

var coll2 = mongos.getCollection('foo.baz');

// cleanupOrphaned fails if startingFrom doesn't match shard key pattern.
assert.commandWorked(mongosAdmin.runCommand({
    shardCollection: coll2.getFullName(),
    key: {a:1, b:1}
}));


// Doesn't match number of keys.
assert.commandFailed(shardAdmin.runCommand({
    cleanupOrphaned: coll2.getFullName(),
    startingFromKey: {someKey: 'someValue'}
}));

// Matches number of keys but not key name.
// TODO: re-enable after SERVER-11104
//assert.commandFailed(shardAdmin.runCommand({
//    cleanupOrphaned: coll2.getFullName(),
//    startingFromKey: {a: 'someValue', c: 1}
//}));

/*****************************************************************************
 * Replication halted.
 ****************************************************************************/

// Put low chunk on shard 0, high chunk on shard 1. One doc in each, plus an
// orphan on shard 0.
assert.commandWorked(mongosAdmin.runCommand({
    split: ns,
    middle: {_id: 0}
}));

var shards = mongos.getCollection('config.shards').find().toArray();
assert.commandWorked(mongosAdmin.runCommand({
    moveChunk: ns,
    find: {_id: 0},
    to: shards[1]._id
}));

var fooDB = mongos.getDB(dbName);
fooDB.getCollection(collectionName).insert([{_id: -1}, {_id: 1}]);
assert(!fooDB.getLastError(), fooDB.getLastError());

shardFooDB.getCollection(collectionName).insert({_id:2});  // An orphan on shard 0.
assert(!shardFooDB.getLastError(2));

// cleanupOrphaned should fail when majority of replica set can't catch up.
// Halt replication on shard 0's secondary, and shorten the primary's wtimeout
// from one hour to one second to speed up the test.
jsTest.log('Stopping replication.');
assert.commandWorked(secondaryAdmin.runCommand({
    configureFailPoint: 'rsSyncApplyStop',
    mode: 'alwaysOn'
}));

jsTest.log('Configuring rangeDeleterWTimeout fail point.');
assert.commandWorked(shardAdmin.runCommand({
    configureFailPoint: 'rangeDeleterWTimeout',
    mode: 'alwaysOn',
    data: {seconds: 1}
}));

jsTest.log('Running cleanupOrphaned with replication stopped.');
response = shardAdmin.runCommand({
    cleanupOrphaned: ns,
    secondaryThrottle: false
});

// "moveChunk repl sync timed out".
printjson(response);
assert.commandFailed(response);
assert.neq(-1, response.errmsg.indexOf('timed out'), response.errmsg);

jsTest.log('Completed cleanupOrphaned with replication stopped.');
assert.commandWorked(secondaryAdmin.runCommand({
    configureFailPoint: 'rsSyncApplyStop',
    mode: 'off'
}));

// Once replication catches up, orphan will be gone from secondary.
var secondaryCollection = st.rs0.getSecondary().getCollection(ns);

// Wait up to 10 seconds for replication to resume and remove orphan from
// secondary.
for (var i = 0; i < 100; i++) {
    if (secondaryCollection.count() != 1) { sleep(100 /* milliseconds */); }
}

assert.eq(1, secondaryCollection.count());

// Restore default timeout for range deleter.
assert.commandWorked(shardAdmin.runCommand({
    configureFailPoint: 'rangeDeleterWTimeout',
    mode: 'off'
}));

/*****************************************************************************
 * Config server down.
 ****************************************************************************/

jsTest.log('Killing config server.');
MongoRunner.stopMongod(st.config0.port);
assert(MongoRunner.isStopped(st.config0.port));

jsTest.log('Running cleanupOrphaned with config server down.');
assert.commandWorked(shardAdmin.runCommand({cleanupOrphaned: ns}));
st.stop();
