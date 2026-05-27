-- Adicionar coluna de status de pagamento na tabela alunos
ALTER TABLE alunos ADD COLUMN IF NOT EXISTS status_pagamento VARCHAR(20) DEFAULT 'pendente';

-- Atualizar alunos que já têm data de pagamento para 'pago'
UPDATE alunos SET status_pagamento = 'pago' WHERE pagamento IS NOT NULL;
