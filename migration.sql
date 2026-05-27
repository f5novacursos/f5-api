-- Adicionar colunas no alunos para rastrear pagamento InfinitePay
ALTER TABLE alunos ADD COLUMN IF NOT EXISTS order_nsu       VARCHAR(60);
ALTER TABLE alunos ADD COLUMN IF NOT EXISTS transaction_nsu VARCHAR(100);
ALTER TABLE alunos ADD COLUMN IF NOT EXISTS receipt_url     VARCHAR(500);
ALTER TABLE alunos ADD COLUMN IF NOT EXISTS forma_pgto      VARCHAR(30);
