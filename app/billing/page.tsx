export default function BillingPlaceholder() {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-800">
      <div className="max-w-2xl mx-auto px-6 py-24 text-center">
        <h1 className="text-3xl font-semibold text-[#1C1C1C] mb-4">Billing Coming Soon</h1>
        <p className="text-lg text-gray-500 mb-8">
          Thanks for using Context! Paid plans aren&apos;t live yet. We&apos;re working with monday.com to launch
          subscriptions soon.
        </p>
        <div className="space-y-4 text-sm text-gray-600">
          <p>Until then you can keep exploring the Free tier and reach out if you need higher limits.</p>
          <p>
            Contact us at <a className="text-[#0073EA] hover:underline" href="mailto:hansenhalim12223@gmail.com">hansenhalim12223@gmail.com</a>{" "}
            and we&apos;ll make sure you&apos;re first in line when upgrades open.
          </p>
        </div>
      </div>
    </div>
  );
}
