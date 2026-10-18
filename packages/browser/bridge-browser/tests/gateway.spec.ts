import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createBrowserGateway, eventsFromRecords, historyFromFrame } from '../src/gateway.ts'

describe('eventsFromRecords', () => {
  it('unwraps real DSH wire records ({ type: "event", event })', () => {
    const rawRecords = [
      {
        type: 'event',
        event: {
          type: 'user/message',
          seq: 1,
          time: 1000,
          data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
        },
      },
      {
        type: 'event',
        event: {
          type: 'assistant/message',
          seq: 2,
          time: 2000,
          data: { message: { content: [{ type: 'text', text: 'hi there' }] } },
        },
      },
    ]

    const result = eventsFromRecords(rawRecords)
    expect(result).toEqual([
      {
        event: {
          type: 'user/message',
          seq: 1,
          time: 1000,
          data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
        },
      },
      {
        event: {
          type: 'assistant/message',
          seq: 2,
          time: 2000,
          data: { message: { content: [{ type: 'text', text: 'hi there' }] } },
        },
      },
    ])
  })

  it('unwraps individual DSH chunk events from history records', () => {
    const chunkRecords = [
      {
        type: 'event',
        event: {
          type: 'assistant/chunk',
          seq: 10,
          time: 5000,
          data: {
            turn: 1,
            step: 1,
            chunk: { type: 'text-delta', index: 0, text: 'chunk-1' },
          },
        },
      },
      {
        type: 'event',
        event: {
          type: 'assistant/chunk',
          seq: 11,
          time: 5010,
          data: {
            turn: 1,
            step: 1,
            chunk: { type: 'text-delta', index: 0, text: 'chunk-2' },
          },
        },
      },
    ]

    const result = eventsFromRecords(chunkRecords)
    expect(result).toHaveLength(2)
    expect(result[0]!.event).toMatchObject({
      type: 'assistant/chunk',
      seq: 10,
      time: 5000,
      data: {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'chunk-1' },
      },
    })
    expect(result[1]!.event).toMatchObject({
      type: 'assistant/chunk',
      seq: 11,
      time: 5010,
      data: {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'chunk-2' },
      },
    })
  })

  it('fails closed on malformed explicit wire envelopes', () => {
    expect(() => eventsFromRecords([{ type: 'event' }])).toThrow(/malformed/)
    expect(() => eventsFromRecords([{ type: 'event', event: null }])).toThrow(/malformed/)
    expect(() => eventsFromRecords([{ type: 'chunks', event: {} }])).toThrow(/unsupported/)
  })

  it('handles bare events from mock/legacy inputs', () => {
    const bareRecords = [
      {
        type: 'user/message',
        seq: 5,
        time: 3000,
        data: { content: 'test' },
      },
    ]
    const result = eventsFromRecords(bareRecords)
    expect(result).toEqual([
      {
        event: {
          type: 'user/message',
          seq: 5,
          time: 3000,
          data: { content: 'test' },
        },
      },
    ])
  })
})

describe('historyFromFrame', () => {
  it('converts snapshot frame to history shape', () => {
    const frame = {
      type: 'snapshot',
      records: [
        {
          type: 'event',
          event: {
            type: 'user/message',
            seq: 1,
            time: 1000,
            data: { content: 'hello' },
          },
        },
      ],
      hasMore: false,
      projections: { asOfSeq: 1, values: { title: 'Test Session' } },
    }

    const history = historyFromFrame(frame)
    expect(history).toEqual({
      events: [
        {
          event: {
            type: 'user/message',
            seq: 1,
            time: 1000,
            data: { content: 'hello' },
          },
        },
      ],
      hasMore: false,
      projections: { asOfSeq: 1, values: { title: 'Test Session' } },
    })
  })
})


describe('Connection peer propagation', () => {
  it('uses the Host-owned peer for calls, streams and event results', async () => {
    const peer = { id: 'admitted-owner', principal: { kind: 'owner' } }
    const invoke = vi.fn(async () => 'value')
    const stream = vi.fn(async () => (async function* () {})())
    const open = vi.fn(async () => (async function* () {})())
    const fetch = vi.fn(async (request: Request, actualPeer: unknown) => {
      expect(actualPeer).toBe(peer)
      const body = await request.json() as { rpcId: string }
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: true } })
    })
    const gateway = createBrowserGateway({
      connection: { browserPeer: peer, createSharedFetchHandler: () => ({ fetch }) },
      typertGateway: { invoke, stream, wireStream: { open } },
    } as unknown as Context)
    const signal = new AbortController().signal
    await gateway.request('settings/describe', {}, signal)
    await gateway.open('session/follow', {}, signal)
    await gateway.open('$events', {}, signal)
    await gateway.respondEvent('client', 'event', { kind: 'next' }, signal)
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ peer, signal }))
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ peer, signal }))
    expect(open.mock.calls[0]?.[3]).toBe(peer)
    expect(fetch).toHaveBeenCalledOnce()
  })
})
