import {
  BaseEntity,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm'

// NOTE: the main process is transpiled per-file by esbuild (vite-plugin-electron
// notBundle), which does not support emitDecoratorMetadata — every column type
// must therefore be declared explicitly.
@Entity('notes')
export class Note extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number

  @Column({ type: 'text' })
  content!: string

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date
}
