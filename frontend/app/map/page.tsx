import type { Metadata } from 'next';
import MapScreen from './MapScreen';

export const metadata: Metadata = { title: 'Tactical map' };

export default async function MapPage({ searchParams }: { searchParams: Promise<{ incident?: string; imagery?: string; radar?: string }> }) {
  const { incident, imagery, radar } = await searchParams;
  return <MapScreen incident={incident} imagery={imagery} radar={radar === '1'} />;
}
