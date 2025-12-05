import { messageBus } from '../src/integration/messaging/message-bus'
import { performance } from 'perf_hooks'

async function runBenchmark() {
  console.log('Starting MessageBus Benchmark...')

  const messageCount = 10000
  let processedCount = 0
  const topic = 'benchmark.topic'

  // Subscribe
  messageBus.subscribe(topic, () => {
    processedCount++
  })

  const start = performance.now()

  // Publish
  for (let i = 0; i < messageCount; i++) {
    await messageBus.publish(topic, { index: i })
  }

  // Wait for processing
  while (processedCount < messageCount) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  const end = performance.now()
  const duration = (end - start) / 1000 // seconds
  const throughput = messageCount / duration

  console.log(`Processed ${messageCount} messages in ${duration.toFixed(2)}s`)
  console.log(`Throughput: ${throughput.toFixed(2)} msg/s`)
}

runBenchmark().catch(console.error)
