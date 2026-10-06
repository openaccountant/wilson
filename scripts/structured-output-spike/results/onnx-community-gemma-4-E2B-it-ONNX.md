# Structured output spike: onnx-community/gemma-4-E2B-it-ONNX

device=cpu dtype=q4f16 batches=10 load=3952ms warmup=252ms

| mode | batches | JSON.parse | zod pass | category accuracy | errors | wall time | tokens/sec |
|---|---|---|---|---|---|---|---|
| prompt-only | 10 | 100.0% | 100.0% | 80.8% (80/99) | 0 | 375.6s | 9.7 |
| constrained | 10 | 100.0% | 100.0% | 80.8% (80/99) | 0 | 368.1s | 9.9 |

Accuracy scores only rows with an `expected` label; an unparseable or schema-invalid batch counts all its labeled rows as wrong. JSON.parse is on the raw output (no extraction); zod pass requires raw JSON.parse success.
