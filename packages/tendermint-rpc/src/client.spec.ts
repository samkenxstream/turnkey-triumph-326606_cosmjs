/* eslint-disable @typescript-eslint/naming-convention */
import { toAscii } from "@cosmjs/encoding";
import { firstEvent, toListPromise } from "@cosmjs/stream";
import { sleep } from "@cosmjs/utils";
import { ReadonlyDate } from "readonly-date";
import { Stream } from "xstream";

import { Adaptor } from "./adaptor";
import { adaptorForVersion } from "./adaptorforversion";
import { Client } from "./client";
import { tendermintInstances } from "./config.spec";
import { buildQuery } from "./requests";
import * as responses from "./responses";
import { HttpClient, RpcClient, WebsocketClient } from "./rpcclients";
import { chainIdMatcher } from "./testutil.spec";
import { TxBytes } from "./types";

function tendermintEnabled(): boolean {
  return !!process.env.TENDERMINT_ENABLED;
}

function pendingWithoutTendermint(): void {
  if (!tendermintEnabled()) {
    pending("Set TENDERMINT_ENABLED to enable tendermint-based tests");
  }
}

async function tendermintSearchIndexUpdated(): Promise<void> {
  // Tendermint needs some time before a committed transaction is found in search
  return sleep(75);
}

function buildKvTx(k: string, v: string): TxBytes {
  return toAscii(`${k}=${v}`) as TxBytes;
}

function randomString(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 12 })
    .map(() => alphabet[Math.floor(Math.random() * alphabet.length)])
    .join("");
}

function defaultTestSuite(rpcFactory: () => RpcClient, adaptor: Adaptor): void {
  it("can connect to tendermint with known version", async () => {
    pendingWithoutTendermint();
    const client = new Client(rpcFactory(), adaptor);
    expect(await client.abciInfo()).toBeTruthy();
    client.disconnect();
  });

  it("can auto-discover tendermint version and connect", async () => {
    pendingWithoutTendermint();
    const client = await Client.detectVersion(rpcFactory());
    const info = await client.abciInfo();
    expect(info).toBeTruthy();
    client.disconnect();
  });

  it("can get genesis", async () => {
    pendingWithoutTendermint();
    const client = new Client(rpcFactory(), adaptor);
    const genesis = await client.genesis();
    expect(genesis).toBeTruthy();
    client.disconnect();
  });

  it("can broadcast a transaction", async () => {
    pendingWithoutTendermint();
    const client = new Client(rpcFactory(), adaptor);
    const tx = buildKvTx(randomString(), randomString());

    const response = await client.broadcastTxCommit({ tx: tx });
    expect(response.height).toBeGreaterThan(2);
    expect(response.hash).toBeTruthy();
    // verify success
    expect(response.checkTx.code).toBeFalsy();
    expect(response.deliverTx).toBeTruthy();
    if (response.deliverTx) {
      expect(response.deliverTx.code).toBeFalsy();
    }

    client.disconnect();
  });

  it("gets the same tx hash from backend as calculated locally", async () => {
    pendingWithoutTendermint();
    const client = new Client(rpcFactory(), adaptor);
    const tx = buildKvTx(randomString(), randomString());
    const calculatedTxHash = adaptor.hashTx(tx);

    const response = await client.broadcastTxCommit({ tx: tx });
    expect(response.hash).toEqual(calculatedTxHash);

    client.disconnect();
  });

  it("can query the state", async () => {
    pendingWithoutTendermint();
    const client = new Client(rpcFactory(), adaptor);

    const key = randomString();
    const value = randomString();
    await client.broadcastTxCommit({ tx: buildKvTx(key, value) });

    const binKey = toAscii(key);
    const binValue = toAscii(value);
    const queryParams = { path: "/key", data: binKey, prove: true };
    const response = await client.abciQuery(queryParams);
    expect(response.key).toEqual(binKey);
    expect(response.value).toEqual(binValue);
    expect(response.code).toBeFalsy();

    client.disconnect();
  });

  it("can call a bunch of methods", async () => {
    pendingWithoutTendermint();
    const client = new Client(rpcFactory(), adaptor);

    expect(await client.block()).toBeTruthy();
    expect(await client.commit(4)).toBeTruthy();
    expect(await client.genesis()).toBeTruthy();
    expect(await client.health()).toBeNull();
    expect(await client.validators()).toBeTruthy();

    client.disconnect();
  });

  describe("status", () => {
    it("works", async () => {
      pendingWithoutTendermint();
      const client = new Client(rpcFactory(), adaptor);

      const status = await client.status();
      expect(status.nodeInfo.other.size).toBeGreaterThanOrEqual(2);
      expect(status.nodeInfo.other.get("tx_index")).toEqual("on");
      expect(status.validatorInfo.pubkey).toBeTruthy();
      expect(status.validatorInfo.votingPower).toBeGreaterThan(0);
      expect(status.syncInfo.catchingUp).toEqual(false);
      expect(status.syncInfo.latestBlockHeight).toBeGreaterThanOrEqual(1);

      client.disconnect();
    });
  });

  describe("blockResults", () => {
    it("works", async () => {
      pendingWithoutTendermint();
      const client = new Client(rpcFactory(), adaptor);

      const height = 3;
      const results = await client.blockResults(height);
      expect(results.height).toEqual(height);
      expect(results.results).toEqual([]);
      expect(results.beginBlockEvents).toEqual([]);
      expect(results.endBlockEvents).toEqual([]);

      client.disconnect();
    });
  });

  describe("blockchain", () => {
    it("returns latest in descending order by default", async () => {
      pendingWithoutTendermint();
      const client = new Client(rpcFactory(), adaptor);

      // Run in parallel to increase chance there is no block between the calls
      const [status, blockchain] = await Promise.all([client.status(), client.blockchain()]);
      const height = status.syncInfo.latestBlockHeight;

      expect(blockchain.lastHeight).toEqual(height);
      expect(blockchain.blockMetas.length).toBeGreaterThanOrEqual(3);
      expect(blockchain.blockMetas[0].header.height).toEqual(height);
      expect(blockchain.blockMetas[1].header.height).toEqual(height - 1);
      expect(blockchain.blockMetas[2].header.height).toEqual(height - 2);

      client.disconnect();
    });

    it("can limit by maxHeight", async () => {
      pendingWithoutTendermint();
      const client = new Client(rpcFactory(), adaptor);

      const height = (await client.status()).syncInfo.latestBlockHeight;
      const blockchain = await client.blockchain(undefined, height - 1);
      expect(blockchain.lastHeight).toEqual(height);
      expect(blockchain.blockMetas.length).toBeGreaterThanOrEqual(2);
      expect(blockchain.blockMetas[0].header.height).toEqual(height - 1); // upper limit included
      expect(blockchain.blockMetas[1].header.height).toEqual(height - 2);

      client.disconnect();
    });

    it("works with maxHeight in the future", async () => {
      pendingWithoutTendermint();
      const client = new Client(rpcFactory(), adaptor);

      const height = (await client.status()).syncInfo.latestBlockHeight;
      const blockchain = await client.blockchain(undefined, height + 20);
      expect(blockchain.lastHeight).toEqual(height);
      expect(blockchain.blockMetas.length).toBeGreaterThanOrEqual(2);
      expect(blockchain.blockMetas[0].header.height).toEqual(height);
      expect(blockchain.blockMetas[1].header.height).toEqual(height - 1);

      client.disconnect();
    });

    it("can limit by minHeight and maxHeight", async () => {
      pendingWithoutTendermint();
      const client = new Client(rpcFactory(), adaptor);

      const height = (await client.status()).syncInfo.latestBlockHeight;
      const blockchain = await client.blockchain(height - 2, height - 1);
      expect(blockchain.lastHeight).toEqual(height);
      expect(blockchain.blockMetas.length).toEqual(2);
      expect(blockchain.blockMetas[0].header.height).toEqual(height - 1); // upper limit included
      expect(blockchain.blockMetas[1].header.height).toEqual(height - 2); // lower limit included

      client.disconnect();
    });

    it("contains all the info", async () => {
      pendingWithoutTendermint();
      const client = new Client(rpcFactory(), adaptor);

      const height = (await client.status()).syncInfo.latestBlockHeight;
      const blockchain = await client.blockchain(height - 1, height - 1);

      expect(blockchain.lastHeight).toEqual(height);
      expect(blockchain.blockMetas.length).toBeGreaterThanOrEqual(1);
      const meta = blockchain.blockMetas[0];

      // TODO: check all the fields
      expect(meta).toEqual({
        blockId: jasmine.objectContaining({}),
        // block_size: jasmine.stringMatching(nonNegativeIntegerMatcher),
        // num_txs: jasmine.stringMatching(nonNegativeIntegerMatcher),
        header: jasmine.objectContaining({
          version: {
            block: 10,
            app: 1,
          },
          chainId: jasmine.stringMatching(chainIdMatcher),
        }),
      });

      client.disconnect();
    });
  });

  describe("tx", () => {
    it("can query a tx properly", async () => {
      pendingWithoutTendermint();
      const client = new Client(rpcFactory(), adaptor);

      const find = randomString();
      const me = randomString();
      const tx = buildKvTx(find, me);

      const txRes = await client.broadcastTxCommit({ tx: tx });
      expect(responses.broadcastTxCommitSuccess(txRes)).toEqual(true);
      expect(txRes.height).toBeTruthy();
      const height: number = txRes.height || 0; // || 0 for type system
      expect(txRes.hash.length).not.toEqual(0);
      const hash = txRes.hash;

      await tendermintSearchIndexUpdated();

      // find by hash - does it match?
      const r = await client.tx({ hash: hash, prove: true });
      // both values come from rpc, so same type (Buffer/Uint8Array)
      expect(r.hash).toEqual(hash);
      // force the type when comparing to locally generated value
      expect(r.tx).toEqual(tx);
      expect(r.height).toEqual(height);
      expect(r.proof).toBeTruthy();

      // txSearch - you must enable the indexer when running
      // tendermint, else you get empty results
      const query = buildQuery({ tags: [{ key: "app.key", value: find }] });

      const s = await client.txSearch({ query: query, page: 1, per_page: 30 });
      // should find the tx
      expect(s.totalCount).toEqual(1);
      // should return same info as querying directly,
      // except without the proof
      expect(s.txs[0]).toEqual({ ...r, proof: undefined });

      // ensure txSearchAll works as well
      const sall = await client.txSearchAll({ query: query });
      // should find the tx
      expect(sall.totalCount).toEqual(1);
      // should return same info as querying directly,
      // except without the proof
      expect(sall.txs[0]).toEqual({ ...r, proof: undefined });

      // and let's query the block itself to see this transaction
      const block = await client.block(height);
      expect(block.block.txs.length).toEqual(1);
      expect(block.block.txs[0]).toEqual(tx);

      client.disconnect();
    });
  });

  describe("txSearch", () => {
    const key = randomString();

    beforeAll(async () => {
      if (tendermintEnabled()) {
        const client = new Client(rpcFactory(), adaptor);

        // eslint-disable-next-line no-inner-declarations
        async function sendTx(): Promise<void> {
          const me = randomString();
          const tx = buildKvTx(key, me);

          const txRes = await client.broadcastTxCommit({ tx: tx });
          expect(responses.broadcastTxCommitSuccess(txRes)).toEqual(true);
          expect(txRes.height).toBeTruthy();
          expect(txRes.hash.length).not.toEqual(0);
        }

        // send 3 txs
        await sendTx();
        await sendTx();
        await sendTx();

        client.disconnect();

        await tendermintSearchIndexUpdated();
      }
    });

    it("can paginate over txSearch results", async () => {
      pendingWithoutTendermint();
      const client = new Client(rpcFactory(), adaptor);

      const query = buildQuery({ tags: [{ key: "app.key", value: key }] });

      // expect one page of results
      const s1 = await client.txSearch({ query: query, page: 1, per_page: 2 });
      expect(s1.totalCount).toEqual(3);
      expect(s1.txs.length).toEqual(2);

      // second page
      const s2 = await client.txSearch({ query: query, page: 2, per_page: 2 });
      expect(s2.totalCount).toEqual(3);
      expect(s2.txs.length).toEqual(1);

      client.disconnect();
    });

    it("can get all search results in one call", async () => {
      pendingWithoutTendermint();
      const client = new Client(rpcFactory(), adaptor);

      const query = buildQuery({ tags: [{ key: "app.key", value: key }] });

      const sall = await client.txSearchAll({ query: query, per_page: 2 });
      expect(sall.totalCount).toEqual(3);
      expect(sall.txs.length).toEqual(3);
      // make sure there are in order from lowest to highest height
      const [tx1, tx2, tx3] = sall.txs;
      expect(tx2.height).toEqual(tx1.height + 1);
      expect(tx3.height).toEqual(tx2.height + 1);

      client.disconnect();
    });
  });
}

function websocketTestSuite(rpcFactory: () => RpcClient, adaptor: Adaptor, appCreator: string): void {
  it("can subscribe to block header events", (done) => {
    pendingWithoutTendermint();

    const testStart = ReadonlyDate.now();

    (async () => {
      const events: responses.NewBlockHeaderEvent[] = [];
      const client = new Client(rpcFactory(), adaptor);
      const stream = client.subscribeNewBlockHeader();
      expect(stream).toBeTruthy();
      const subscription = stream.subscribe({
        next: (event) => {
          expect(event.chainId).toMatch(chainIdMatcher);
          expect(event.height).toBeGreaterThan(0);
          // seems that tendermint just guarantees within the last second for timestamp
          expect(event.time.getTime()).toBeGreaterThan(testStart - 1000);
          // Tendermint clock is sometimes ahead of test clock. Add 10ms tolerance
          expect(event.time.getTime()).toBeLessThanOrEqual(ReadonlyDate.now() + 10);
          expect(event.lastBlockId).toBeTruthy();

          // merkle roots for proofs
          expect(event.appHash).toBeTruthy();
          expect(event.consensusHash).toBeTruthy();
          expect(event.dataHash).toBeTruthy();
          expect(event.evidenceHash).toBeTruthy();
          expect(event.lastCommitHash).toBeTruthy();
          expect(event.lastResultsHash).toBeTruthy();
          expect(event.validatorsHash).toBeTruthy();

          events.push(event);

          if (events.length === 2) {
            subscription.unsubscribe();
            expect(events.length).toEqual(2);
            expect(events[1].chainId).toEqual(events[0].chainId);
            expect(events[1].height).toEqual(events[0].height + 1);
            expect(events[1].time.getTime()).toBeGreaterThan(events[0].time.getTime());

            expect(events[1].appHash).toEqual(events[0].appHash);
            expect(events[1].consensusHash).toEqual(events[0].consensusHash);
            expect(events[1].dataHash).toEqual(events[0].dataHash);
            expect(events[1].evidenceHash).toEqual(events[0].evidenceHash);
            expect(events[1].lastCommitHash).not.toEqual(events[0].lastCommitHash);
            expect(events[1].lastResultsHash).not.toEqual(events[0].lastResultsHash);
            expect(events[1].validatorsHash).toEqual(events[0].validatorsHash);

            client.disconnect();
            done();
          }
        },
        error: done.fail,
        complete: () => done.fail("Stream completed before we are done"),
      });
    })().catch(done.fail);
  });

  it("can subscribe to block events", async () => {
    pendingWithoutTendermint();

    const testStart = ReadonlyDate.now();

    const transactionData1 = buildKvTx(randomString(), randomString());
    const transactionData2 = buildKvTx(randomString(), randomString());

    const events: responses.NewBlockEvent[] = [];
    const client = new Client(rpcFactory(), adaptor);
    const stream = client.subscribeNewBlock();
    const subscription = stream.subscribe({
      next: (event) => {
        expect(event.header.chainId).toMatch(chainIdMatcher);
        expect(event.header.height).toBeGreaterThan(0);
        // seems that tendermint just guarantees within the last second for timestamp
        expect(event.header.time.getTime()).toBeGreaterThan(testStart - 1000);
        // Tendermint clock is sometimes ahead of test clock. Add 10ms tolerance
        expect(event.header.time.getTime()).toBeLessThanOrEqual(ReadonlyDate.now() + 10);
        expect(event.header.lastBlockId).toBeTruthy();

        // merkle roots for proofs
        expect(event.header.appHash).toBeTruthy();
        expect(event.header.consensusHash).toBeTruthy();
        expect(event.header.dataHash).toBeTruthy();
        expect(event.header.evidenceHash).toBeTruthy();
        expect(event.header.lastCommitHash).toBeTruthy();
        expect(event.header.lastResultsHash).toBeTruthy();
        expect(event.header.validatorsHash).toBeTruthy();

        events.push(event);

        if (events.length === 2) {
          subscription.unsubscribe();
        }
      },
      error: fail,
    });

    await client.broadcastTxCommit({ tx: transactionData1 });
    await client.broadcastTxCommit({ tx: transactionData2 });

    // wait for events to be processed
    await sleep(100);

    expect(events.length).toEqual(2);
    // Block header
    expect(events[1].header.height).toEqual(events[0].header.height + 1);
    expect(events[1].header.chainId).toEqual(events[0].header.chainId);
    expect(events[1].header.time.getTime()).toBeGreaterThan(events[0].header.time.getTime());
    expect(events[1].header.appHash).not.toEqual(events[0].header.appHash);
    expect(events[1].header.validatorsHash).toEqual(events[0].header.validatorsHash);
    // Block body
    expect(events[0].txs.length).toEqual(1);
    expect(events[1].txs.length).toEqual(1);
    expect(events[0].txs[0]).toEqual(transactionData1);
    expect(events[1].txs[0]).toEqual(transactionData2);

    client.disconnect();
  });

  it("can subscribe to transaction events", async () => {
    pendingWithoutTendermint();

    const events: responses.TxEvent[] = [];
    const client = new Client(rpcFactory(), adaptor);
    const stream = client.subscribeTx();
    const subscription = stream.subscribe({
      next: (event) => {
        expect(event.height).toBeGreaterThan(0);
        expect(event.index).toEqual(0);
        expect(event.result).toBeTruthy();
        expect(event.result.events.length).toBeGreaterThanOrEqual(1);

        events.push(event);

        if (events.length === 2) {
          subscription.unsubscribe();
        }
      },
      error: fail,
    });

    const transactionData1 = buildKvTx(randomString(), randomString());
    const transactionData2 = buildKvTx(randomString(), randomString());

    await client.broadcastTxCommit({ tx: transactionData1 });
    await client.broadcastTxCommit({ tx: transactionData2 });

    // wait for events to be processed
    await sleep(100);

    expect(events.length).toEqual(2);
    // Meta
    expect(events[1].height).toEqual(events[0].height + 1);
    expect(events[1].result.events).not.toEqual(events[0].result.events);
    // Content
    expect(events[0].tx).toEqual(transactionData1);
    expect(events[1].tx).toEqual(transactionData2);

    client.disconnect();
  });

  it("can subscribe to transaction events filtered by creator", async () => {
    pendingWithoutTendermint();

    const transactionData1 = buildKvTx(randomString(), randomString());
    const transactionData2 = buildKvTx(randomString(), randomString());

    const events: responses.TxEvent[] = [];
    const client = new Client(rpcFactory(), adaptor);
    const query = buildQuery({ tags: [{ key: "app.creator", value: appCreator }] });
    const stream = client.subscribeTx(query);
    expect(stream).toBeTruthy();
    const subscription = stream.subscribe({
      next: (event) => {
        expect(event.height).toBeGreaterThan(0);
        expect(event.index).toEqual(0);
        expect(event.result).toBeTruthy();
        expect(event.result.events.length).toBeGreaterThanOrEqual(1);
        events.push(event);

        if (events.length === 2) {
          subscription.unsubscribe();
        }
      },
      error: fail,
    });

    await client.broadcastTxCommit({ tx: transactionData1 });
    await client.broadcastTxCommit({ tx: transactionData2 });

    // wait for events to be processed
    await sleep(100);

    expect(events.length).toEqual(2);
    // Meta
    expect(events[1].height).toEqual(events[0].height + 1);
    expect(events[1].result.events).not.toEqual(events[0].result.events);
    // Content
    expect(events[0].tx).toEqual(transactionData1);
    expect(events[1].tx).toEqual(transactionData2);

    client.disconnect();
  });

  it("can unsubscribe and re-subscribe to the same stream", async () => {
    pendingWithoutTendermint();

    const client = new Client(rpcFactory(), adaptor);
    const stream = client.subscribeNewBlockHeader();

    const event1 = await firstEvent(stream);
    expect(event1.height).toBeGreaterThanOrEqual(1);
    expect(event1.time.getTime()).toBeGreaterThanOrEqual(1);

    // No sleep: producer will not be stopped in the meantime

    const event2 = await firstEvent(stream);
    expect(event2.height).toBeGreaterThan(event1.height);
    expect(event2.time.getTime()).toBeGreaterThan(event1.time.getTime());

    // Very short sleep: just enough to schedule asynchronous producer stopping
    await sleep(5);

    const event3 = await firstEvent(stream);
    expect(event3.height).toBeGreaterThan(event2.height);
    expect(event3.time.getTime()).toBeGreaterThan(event2.time.getTime());

    // Proper sleep: enough to finish unsubscribing at over the network
    await sleep(100);

    const event4 = await firstEvent(stream);
    expect(event4.height).toBeGreaterThan(event3.height);
    expect(event4.time.getTime()).toBeGreaterThan(event3.time.getTime());

    client.disconnect();
  });

  it("can subscribe twice", async () => {
    pendingWithoutTendermint();

    const client = new Client(rpcFactory(), adaptor);
    const stream1 = client.subscribeNewBlockHeader();
    const stream2 = client.subscribeNewBlockHeader();

    const events = await toListPromise(Stream.merge(stream1, stream2), 4);

    expect(new Set(events.map((e) => e.height)).size).toEqual(2);

    client.disconnect();
  });
}

for (const { url, version, appCreator } of tendermintInstances) {
  describe(`Client ${version}`, () => {
    it("can connect to a given url", async () => {
      pendingWithoutTendermint();

      // default connection
      {
        const client = await Client.connect(url);
        const info = await client.abciInfo();
        expect(info).toBeTruthy();
        client.disconnect();
      }

      // http connection
      {
        const client = await Client.connect("http://" + url);
        const info = await client.abciInfo();
        expect(info).toBeTruthy();
        client.disconnect();
      }

      // ws connection
      {
        const client = await Client.connect("ws://" + url);
        const info = await client.abciInfo();
        expect(info).toBeTruthy();
        client.disconnect();
      }
    });

    describe("With HttpClient", () => {
      const adaptor = adaptorForVersion(version);
      defaultTestSuite(() => new HttpClient(url), adaptor);
    });

    describe("With WebsocketClient", () => {
      // don't print out WebSocket errors if marked pending
      const onError = process.env.TENDERMINT_ENABLED ? console.error : () => 0;
      const factory = (): WebsocketClient => new WebsocketClient(url, onError);
      const adaptor = adaptorForVersion(version);
      defaultTestSuite(factory, adaptor);
      websocketTestSuite(factory, adaptor, appCreator);
    });
  });
}
