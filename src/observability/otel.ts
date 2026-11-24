import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { NodeSDK } from '@opentelemetry/sdk-node'

/**
 * Must be the first import of every entry point: auto-instrumentation patches
 * http, express and pg at require time, so anything loaded earlier stays dark.
 * Without an endpoint there is nowhere to export to, so the SDK stays off
 * instead of retrying against localhost forever.
 */
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT

const sdk = endpoint
	? new NodeSDK({
			serviceName: process.env.OTEL_SERVICE_NAME ?? 'marketplace-api',
			traceExporter: new OTLPTraceExporter({
				url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
			}),
			instrumentations: [
				getNodeAutoInstrumentations({
					'@opentelemetry/instrumentation-fs': { enabled: false },
					'@opentelemetry/instrumentation-net': { enabled: false },
					'@opentelemetry/instrumentation-dns': { enabled: false },
					'@opentelemetry/instrumentation-pino': { enabled: false },
				}),
			],
		})
	: undefined

sdk?.start()

/** The batch processor holds spans for seconds; exiting without this drops them. */
export async function shutdownTelemetry(): Promise<void> {
	await sdk?.shutdown()
}
