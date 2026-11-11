CREATE TABLE "ProgramEditHistory" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "programId" TEXT NOT NULL,
  "actorOwnerId" TEXT NOT NULL,
  "beforeValues" JSONB NOT NULL,
  "afterValues" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProgramEditHistory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProgramEditHistory_programId_merchantId_fkey"
    FOREIGN KEY ("programId", "merchantId")
    REFERENCES "Program"("id", "merchantId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProgramEditHistory_actorOwnerId_fkey"
    FOREIGN KEY ("actorOwnerId")
    REFERENCES "Owner"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "ProgramEditHistory_merchantId_programId_createdAt_idx"
  ON "ProgramEditHistory"("merchantId", "programId", "createdAt");
