import { OpenTelemetryTransportV3 } from '@opentelemetry/winston-transport';
import { LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { logs } from '@opentelemetry/api-logs';

let loggerProvider: LoggerProvider | null = null;

export function createOtelTransport(): OpenTelemetryTransportV3 | null {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return null;

  try {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'wilson',
      [ATTR_SERVICE_VERSION]: '0.1.0',
    });

    const exporter = new OTLPLogExporter({
      url: `${endpoint.replace(/\/+$/, '')}/v1/logs`,
    });

    loggerProvider = new LoggerProvider({
      resource,
      processors: [new SimpleLogRecordProcessor(exporter)],
    });

    // Register globally so the Winston transport can find it
    logs.setGlobalLoggerProvider(loggerProvider);

    return new OpenTelemetryTransportV3();
  } catch {
    return null;
  }
}

export async function shutdownOtel(): Promise<void> {
  if (loggerProvider) {
    try {
      await loggerProvider.shutdown();
    } catch {
      // Ignore shutdown errors
    }
    loggerProvider = null;
  }
}
