# Structured output spike: onnx-community/granite-4.0-350m-ONNX-web

device=cpu dtype=q4f16 batches=50 load=287ms warmup=66ms

| mode | batches | JSON.parse | zod pass | category accuracy | errors | wall time | tokens/sec |
|---|---|---|---|---|---|---|---|
| prompt-only | 50 | 100.0% | 100.0% | 6.6% (33/502) | 0 | 340.0s | 35.7 |
| constrained | 50 | 100.0% | 100.0% | 6.6% (33/502) | 0 | 333.4s | 36.4 |

Accuracy scores only rows with an `expected` label; an unparseable or schema-invalid batch counts all its labeled rows as wrong. JSON.parse is on the raw output (no extraction); zod pass requires raw JSON.parse success.
