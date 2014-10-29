'use strict';

var EventEmitter = require('eventemitter3')
  , Tick = require('tick-tock');

/**
 * Generate a somewhat unique UUID.
 *
 * @see stackoverflow.com/q/105034
 * @returns {String} UUID.
 * @api private
 */
function UUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function gen(c) {
    var random = Math.random() * 16 | 0
      , value = c !== 'x'
        ? (random & 0x3 | 0x8)
        : random;

    return value.toString(16);
  });
}

/**
 * Representation of a single node in the cluster.
 *
 * Options:
 *
 * - `id`: An unique id of this given node.
 * - `heartbeat min`: Minimum heartbeat timeout.
 * - `heartbeat max`: Maximum heartbeat timeout.
 * - `election min`: Minimum election timeout.
 * - `election max`: Maximum election timeout.
 * - `threshold`: Threshold when the heartbeat RTT is close to the election
 *   timeout.
 *
 * @constructor
 * @param {Object} options Node configuration.
 * @api public
 */
function Node(options) {
  if (!(this instanceof Node)) return new Node(options);

  options = options || {};

  this.election = {
    min: Tick.parse(options['election min'] || '150 ms'),
    max: Tick.parse(options['election max'] || '300 ms')
  };

  this.beat = {
    min: Tick.parse(options['heartbeat min'] || '50 ms'),
    max: Tick.parse(options['heartbeat max'] || '70 ms')
  };

  this.votes = {
    for: null,                // Who did we vote for in this current term.
    granted: 0                // How many votes we're granted to us.
  };

  this.threshold = options.threshold || 0.8;
  this.name = options.name || UUID();
  this.timers = new Tick(this);

  //
  // Raft §5.2:
  //
  // When a server starts, it's always started as Follower and it will remain in
  // this state until receive a message from a Leader or Candidate.
  //
  this.state = Node.FOLLOWER; // Our current state.
  this.leader = null;         // Leader in our cluster.
  this.term = 0;              // Our current term.

  this.initialize();
}

//
// Add some sugar and spice and everything nice. Oh, and also inheritance.
//
Node.extend = require('extendable');
Node.prototype = new EventEmitter();
Node.prototype.emits = require('emits');
Node.prototype.constructor = Node;

/**
 * Raft §5.1:
 *
 * A Node can be in only one of the various states. The stopped state is not
 * something that is part of the Raft protocol but something we might want to
 * use internally while we're starting or shutting down our node.
 *
 * @type {Number}
 * @private
 */
Node.LEADER    = 1;   // We're selected as leader process.
Node.CANDIDATE = 2;   // We want to be promoted to leader.
Node.FOLLOWER  = 3;   // We're just following a leader.
Node.STOPPED   = 4;   // Assume we're dead.

/**
 * Initialize the node and start listening to the various of events we're
 * emitting as we're quite chatty to provide the maximum amount of flexibility
 * and reconfigurability.
 *
 * @api private
 */
Node.prototype.initialize = function initialize() {
  //
  // Reset our vote as we're starting a new term. Votes only last one term.
  //
  this.on('term change', function change() {
    this.votes.for = null;
    this.votes.granted = 0;
  });

  //
  // Reset our times and start the heartbeat again. If we're promoted to leader
  // the heartbeat will automatically be broadcasted to users as well.
  //
  this.on('state change', function change(currently, previously) {
    this.timers.clear();
    this.heartbeat();
  });

  //
  // Receive incoming messages and process them.
  //
  this.on('data', function incoming(data) {
    if ('object' !== typeof data) {
      return; /* Invalid data structure, G.T.F.O. */
    }

    //
    // Raft §5.1:
    //
    // Applies to all states. If a response contains a higher term then our
    // current term need to change our state to FOLLOWER and set the received
    // term.
    //
    // If the node receives a request with a stale term number it should be
    // rejected.
    //
    if (data.term > this.term) {
      this.change({
        state: Node.FOLLOWER,
        term: data.term
      });
    } else if (data.term < this.term) {
      return;
    }

    //
    // Raft §5.2:
    //
    // If we receive a message from someone who claims to be leader and shares
    // our same term while we're in candidate mode we will recognize their
    // leadership and return as follower
    //
    if (Node.LEADER === data.state && Node.FOLLOWER !== this.state) {
      this.change({ state: Node.FOLLOWER });
    }

    switch (data.type) {
      case 'heartbeat':
        if (Node.LEADER === data.state) {
          this.heartbeat(data.data);
        }
      break;

      //
      // Raft §5.2:
      // Raft §5.4:
      //
      // A node asked us to vote on them. We can only vote to them if they
      // represent a higher term (and last log term, last log index).
      //
      case 'vote':
        //
        // If the request is coming from an old term we should deny it.
        //
        if (data.term < this.term) {
          this.emit('vote', data, false);
          return this.write('vote', { granted: false });
        }

        //
        // The term of the vote is bigger then ours so we need to update it. If
        // it's the same and we already voted, we need to deny the vote.
        //
        if (data.term > this.term) this.change({ term: data.term });
        else if (this.votes.for && this.votes.for !== data.name) {
          this.emit('vote', data, false);
          return this.write('vote', { granted: false });
        }

        //
        // If we maintain a log, check if the candidates log is as up to date as
        // ours.
        //

        //
        // We've made our decision, we haven't voted for this term yet and this
        // candidate came in first so it gets our vote as all requirements are
        // met.
        //
        this.votes.for = data.name;
        this.emit('vote', data, true);
        this.write('vote', { granted: true });
      break;

      //
      // A new incoming vote.
      //
      case 'voted':
        //
        // Only accepts votes while we're still in a CANDIDATE state.
        //
        if (Node.CANDIDATE !== this.state) return;

        //
        // Increment our received votes when our voting request has been
        // granted by the node that received the data.
        //
        if (data.payload.granted && data.term === this.term) {
          this.votes.granted++;
        }

        //
        // Again, update our term if it's out sync.
        //
        if (data.term > this.term) this.change({ term: data.term });

        //
        // Check if we've received the minimal amount of votes required for this
        // current voting round to be considered valid
        //
        if (this.votes.granted >= this.quorum()) {
          this.change({
            leader: this.name,
            state: Node.LEADER
          });
        }
      break;

      case 'rpc':
      break;
    }
  });
};

/**
 * The minimum amount of votes we need to receive in order for a voting round to
 * be considered valid.
 *
 * @returns {Number}
 * @api private
 */
Node.prototype.quorum = function quorum() {
  return Math.ceil(this.nodes.length / 2) + 1;
};

/**
 * Process a change in the node.
 *
 * @param {Object} changed Data that is changed.
 * @returns {Node}
 * @api private
 */
Node.prototype.change = function change(changed) {
  var changes = ['term', 'leader', 'state']
    , currently, previously
    , i = 0;

  if (!changed) return this;

  for (; i < changes.length; i++) {
    if (changes[i] in changed && changed[changes[i]] !== this[changes[i]]) {
      currently = changed[changes[i]];
      previously = this[changes[i]];

      this[changes[i]] = currently;
      this.emit(changes[i] +' change', currently, previously);
    }
  }

  return this;
};

/**
 * Start or update the heartbeat of the Node. If we detect that we've received
 * a heartbeat timeout we will promote our selfs to a candidate to take over the
 * leadership.
 *
 * @param {String|Number} duration Time it would take for the heartbeat to timeout.
 * @returns {Node}
 * @api public
 */
Node.prototype.heartbeat = function heartbeat(duration) {
  duration = duration || this.timeout('heartbeat');

  if (this.timers.active('heartbeat')) {
    this.timers.adjust('heartbeat', duration);
    return this;
  }

  this.timers.setTimeout('heartbeat', function () {
    if (Node.LEADER !== this.state) {
      this.emit('heartbeat timeout');
      return this.promote();
    }

    //
    // We're the LEADER so we should be broadcasting.
    //
    this.broadcast('heartbeat');
  }, duration);

  return this;
};

/**
 * Generate the various of timeouts.
 *
 * @param {String} which Type of timeout we want to generate.
 * @returns {Number}
 * @api public
 */
Node.prototype.timeout = function timeout(which) {
  var times = this[which];

  return Math.floor(Math.random() * (times.max - times.min + 1) + times.min);
};

/**
 * Raft §5.2:
 *
 * We've detected a timeout from the leaders heartbeats and need to start a new
 * election for leadership. We increment our current term, set the CANDIDATE
 * state, vote our selfs and ask all others nodes to vote for us.
 *
 * @returns {Node}
 * @api public
 */
Node.prototype.promote = function promote() {
  this.change({
    state: Node.CANDIDATE,  // We're now a candidate,
    term: this.term + 1,    // but only for this term.
    leader: ''              // We no longer have a leader.
  });

  //
  // Candidates are always biased and vote for them selfs first before sending
  // out a voting request to all other nodes in the cluster.
  //
  this.votes.for = this.name;
  this.votes.granted = 1;

  //
  // Set the election timeout. This gives the nodes some time to reach
  // consensuses about who they want to vote for. If no consensus has been
  // reached within the set timeout we will attempt it again.
  //
  this.timers.setTimeout('election', this.promote, this.timeout('election'));

  return this;
};

/**
 * While we don't really adapt the Stream interface here from node, we still
 * want to follow it's API signature. So we assume that the `write` method will
 * return a boolean indicating if the packet has been written.
 *
 * @param {Object} packet The data that needs to be written.
 * @returns {Boolean} Indication that the message was written.
 * @api public
 */
Node.prototype.write = function write(packet) {
  return false;
};

/**
 * Read and process an incoming data packet.
 *
 * @returns {Boolean} Did we read the message.
 * @api public
 */
Node.prototype.read = function read(packet) {
  return this.emit('data', packet);
};

/**
 * Broadcast a message.
 *
 * @param {String} type Message type we're trying to send.
 * @param {Mixed} data Data to be transfered.
 * @returns {Boolean} Successful write.
 * @api public
 */
Node.prototype.broadcast = function broadcast(type, data) {
  var packet = this.packet(type, data);
};

/**
 * Wrap the outgoing messages in an object with additional required data.
 *
 * @param {String} type Message type we're trying to send.
 * @param {Mixed} data Data to be transfered.
 * @returns {Object} Packet.
 * @api private
 */
Node.prototype.packet = function packet(type, data) {
  return {
    state: this.state,  // So you know if we're a leader, candidate or follower
    term:  this.term,   // Our current term so we can find mis matches
    name:  this.name,   // Name of the sender.
    data:  data,        // Custom data we send.
    type:  type         // Message type.
  };
};

/**
 * This Node needs to be shut down.
 *
 * @returns {Boolean} Successful destruction.
 * @api public
 */
Node.prototype.end = function end() {
  if (!this.state) return false;

  this.timers.end();
  this.removeAllListeners();

  this.timers = this.state = this.write = this.read = null;

  return true;
};

//
// Expose the module interface.
//
module.exports = Node;
