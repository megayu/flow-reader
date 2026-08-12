use std::io::{self, Read, Seek, SeekFrom};

use windows::Win32::System::Com::{IStream, STREAM_SEEK_CUR, STREAM_SEEK_END, STREAM_SEEK_SET};

pub(crate) struct StreamReader<'a> {
    stream: &'a IStream,
}

impl<'a> StreamReader<'a> {
    pub(crate) fn new(stream: &'a IStream) -> Self {
        Self { stream }
    }
}

impl Read for StreamReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let requested = buffer.len().min(u32::MAX as usize) as u32;
        let mut read = 0;
        unsafe {
            self.stream
                .Read(buffer.as_mut_ptr().cast(), requested, Some(&mut read))
                .ok()
                .map_err(io_error)?;
        }
        Ok(read as usize)
    }
}

impl Seek for StreamReader<'_> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let (offset, origin) = match position {
            SeekFrom::Start(offset) => (
                i64::try_from(offset).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidInput, "stream offset exceeds i64")
                })?,
                STREAM_SEEK_SET,
            ),
            SeekFrom::Current(offset) => (offset, STREAM_SEEK_CUR),
            SeekFrom::End(offset) => (offset, STREAM_SEEK_END),
        };
        let mut new_position = 0;
        unsafe {
            self.stream
                .Seek(offset, origin, Some(&mut new_position))
                .map_err(io_error)?;
        }
        Ok(new_position)
    }
}

fn io_error(error: windows::core::Error) -> io::Error {
    io::Error::other(error.to_string())
}
