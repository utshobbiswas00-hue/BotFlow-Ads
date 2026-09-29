import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui/EmptyState';

export function NotFoundPage() {
  return (
    <div className="pt-10">
      <EmptyState
        icon="search"
        title="Page not found"
        message="This page doesn't exist or was moved."
        action={
          <Link to="/" className="h-10 px-5 inline-flex items-center rounded-xl bg-accent text-accentink text-sm font-semibold">
            Go home
          </Link>
        }
      />
    </div>
  );
}
