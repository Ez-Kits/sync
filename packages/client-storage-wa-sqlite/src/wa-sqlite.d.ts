// The package's own declarations predate these VFS classes and their `create` factories.
declare module "@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js" {
  export const OPFSCoopSyncVFS: {
    create(name: string, module: unknown): Promise<SQLiteVFS>;
  };
}
