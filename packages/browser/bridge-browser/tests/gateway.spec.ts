import { describe, expect, it } from 'vitest'
import { eventsFromRecords, historyFromFrame } from '../src/gateway.ts'

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

  it('unwraps and expands real DSH packed chunk records ({ type: "chunks", event })', () => {
    const chunkRecords = [
      {
        type: 'chunks',
        event: {
          type: 'chunkrow/text-chunks',
          seq: 10,
          time: 5000,
          data: {
            turn: 1,
            step: 1,
            index: 0,
            dt: [10],
            texts: ['chunk-1', 'chunk-2'],
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
