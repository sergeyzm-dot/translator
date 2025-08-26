import { NextRequest, NextResponse } from 'next/server';
import { readdir, unlink, stat } from 'fs/promises';
import { join } from 'path';

export async function POST(request: NextRequest) {
  try {
    // Simple auth check - in production, use proper authentication
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CLEANUP_SECRET || 'cleanup-secret'}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const tempDir = join(process.cwd(), 'temp');
    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;
    
    let deletedFiles = 0;

    try {
      const files = await readdir(tempDir);
      
      for (const file of files) {
        const filePath = join(tempDir, file);
        const stats = await stat(filePath);
        
        // Delete files older than 24 hours
        if (now - stats.mtime.getTime() > twentyFourHours) {
          await unlink(filePath);
          deletedFiles++;
        }
      }
    } catch (error) {
      // Directory might not exist yet
      console.log('Temp directory not found or empty');
    }

    return NextResponse.json({ 
      message: `Cleanup completed. Deleted ${deletedFiles} files.`,
      deletedFiles 
    });
  } catch (error) {
    console.error('Cleanup error:', error);
    return NextResponse.json(
      { error: 'Cleanup failed' },
      { status: 500 }
    );
  }
}