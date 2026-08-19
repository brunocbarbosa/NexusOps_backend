Pontos Chave da Modelagem Arquitetural:

Multi-tenancy Físico: Todas as tabelas filhas (como User, Ticket e AuditLog) possuem a coluna obrigatória tenant_id e a relação direta com a entidade Tenant. Isto será fundamental para aplicarmos as Prisma Client Extensions e garantirmos o isolamento dos dados.


Campos JSON para Auditoria: Na tabela AuditLog, utilizámos o tipo nativo Json do Prisma para as colunas old_values e new_values. O Prisma traduzirá isto automaticamente para JSONB no PostgreSQL, permitindo armazenar cargas de dados (payloads) flexíveis a cada alteração.


Controlo de Concorrência: O modelo Ticket possui o campo inteiro version iniciado a 1. Quando o backend atualizar o registo, iremos procurar pelo id e pela versão atual, lançando um erro 409 Conflict se outro utilizador já tiver modificado o chamado.


Mapeamento de Nomes (@@map): Utilizamos a diretiva @@map e @map para garantir que o código no NestJS em TypeScript use o padrão camelCase (ex: tenantId), mas na base de dados PostgreSQL as tabelas e colunas sejam criadas no formato correto snake_case (ex: tenant_id).




generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ==========================================
// ENUMS
// ==========================================
enum UserRole {
  ADMIN
  AGENT
  REQUESTER
}

enum TicketStatus {
  OPEN
  IN_PROGRESS
  RESOLVED
  CLOSED
}

// ==========================================
// 1. TENANTS (Empresas Clientes)
// ==========================================
model Tenant {
  id        String   @id @default(uuid()) @db.Uuid
  name      String   @db.VarChar(255)
  domain    String?  @unique @db.VarChar(100)
  isActive  Boolean  @default(true) @map("is_active")
  createdAt DateTime @default(now()) @map("created_at")

  // Relacionamentos
  users     User[]
  tickets   Ticket[]
  auditLogs AuditLog[]

  @@map("tenants")
}

// ==========================================
// 2. USERS (Controle de Acesso - RBAC)
// ==========================================
model User {
  id           String   @id @default(uuid()) @db.Uuid
  tenantId     String   @map("tenant_id") @db.Uuid
  email        String   @db.VarChar(255)
  passwordHash String   @map("password_hash") @db.VarChar(255)
  role         UserRole @default(REQUESTER)
  createdAt    DateTime @default(now()) @map("created_at")

  // Relacionamentos
  tenant          Tenant     @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  ticketsCreated  Ticket[]   @relation("TicketRequester")
  ticketsAssigned Ticket[]   @relation("TicketAssignee")
  auditLogs       AuditLog[]

  // Garante que um e-mail não se repita dentro da mesma empresa
  @@unique([tenantId, email])
  @@index([tenantId])
  @@map("users")
}

// ==========================================
// 3. TICKETS (O Core Domain)
// ==========================================
model Ticket {
  id          String       @id @default(uuid()) @db.Uuid
  tenantId    String       @map("tenant_id") @db.Uuid
  requesterId String       @map("requester_id") @db.Uuid
  assigneeId  String?      @map("assignee_id") @db.Uuid
  title       String       @db.VarChar(255)
  description String?      @db.Text
  status      TicketStatus @default(OPEN)
  
  // CONTROLE OTIMISTA DE CONCORRÊNCIA
  version     Int          @default(1)
  
  createdAt   DateTime     @default(now()) @map("created_at")
  updatedAt   DateTime     @updatedAt @map("updated_at")

  // Relacionamentos
  tenant    Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  requester User   @relation("TicketRequester", fields: [requesterId], references: [id])
  assignee  User?  @relation("TicketAssignee", fields: [assigneeId], references: [id])

  @@index([tenantId])
  @@index([tenantId, status])
  @@map("tickets")
}

// ==========================================
// 4. AUDIT LOGS (Trilha de Auditoria)
// ==========================================
model AuditLog {
  id         String   @id @default(uuid()) @db.Uuid
  tenantId   String   @map("tenant_id") @db.Uuid
  userId     String?  @map("user_id") @db.Uuid
  entityType String   @map("entity_type") @db.VarChar(50)
  entityId   String   @map("entity_id") @db.Uuid
  action     String   @db.VarChar(50)
  
  // O poder do PostgreSQL: JSONB mapeado nativamente no Prisma
  oldValues  Json?    @map("old_values")
  newValues  Json?    @map("new_values")
  
  createdAt  DateTime @default(now()) @map("created_at")

  // Relacionamentos
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user   User?  @relation(fields: [userId], references: [id])

  @@index([entityType, entityId])
  @@index([tenantId])
  @@map("audit_logs")
}